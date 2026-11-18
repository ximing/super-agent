#!/usr/bin/env python3
"""Loopback-only, allowlisted CONNECT tunnel for the private CI runner.

Python 3.6+; forwards encrypted bytes without TLS termination. No request,
header, credential, target URL or payload is logged. An SSH reverse forward
provides the only intended remote access to this loopback listener.
"""
import ipaddress
import re
import select
import socket
import socketserver
import threading
import time


BIND = ("127.0.0.1", 3128)
MAX_HEADER = 16384
CONNECT_TIMEOUT = 8
IDLE_TIMEOUT = 600
MAX_TUNNEL_SECONDS = 21600
MAX_CONNECTIONS = 96

# Entries match an exact hostname or a label-delimited child. These provider
# domains cover runner control, downloads, artifacts and this project's npm/
# Node bootstrap. They are not an unrestricted general-purpose web proxy.
DOMAIN_SUFFIXES = (
    "github.com",
    "githubusercontent.com",
    "githubassets.com",
    "githubapp.com",
    "blob.core.windows.net",
    "nodejs.org",
    "npmjs.org",
)
EXACT_HOSTS = frozenset((
    "login.microsoftonline.com",
    "login.windows.net",
    "aadcdn.msauth.net",
    "aadcdn.msftauth.net",
    "ocsp.digicert.com",
    "cacerts.digicert.com",
    "crl3.digicert.com",
    "crl4.digicert.com",
    "oneocsp.microsoft.com",
    "www.microsoft.com",
))


def allowed_authority(authority):
    """Return the approved DNS host, never a URL/IP/alternate port."""
    match = re.fullmatch(r"([A-Za-z0-9.-]+):443", authority)
    if not match:
        return None
    host = match.group(1).lower()
    if len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
        return None
    try:
        ipaddress.ip_address(host)
        return None
    except ValueError:
        pass
    if host in EXACT_HOSTS or any(host == domain or host.endswith("." + domain) for domain in DOMAIN_SUFFIXES):
        return host
    return None


def open_upstream(host):
    # Resolve only approved names and refuse private/loopback/link-local DNS
    # answers; the SSH relay cannot turn this into an internal-network proxy.
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise OSError("Non-public destination")
    for family, kind, protocol, _, address in addresses[:4]:
        upstream = socket.socket(family, kind, protocol)
        upstream.settimeout(CONNECT_TIMEOUT)
        try:
            upstream.connect(address)
            return upstream
        except OSError:
            upstream.close()
    raise OSError("Upstream unavailable")


def relay(client, upstream):
    sources = [client, upstream]
    peers = {client: upstream, upstream: client}
    deadline = time.monotonic() + MAX_TUNNEL_SECONDS
    client.settimeout(30)
    upstream.settimeout(30)
    while sources:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        readable, _, _ = select.select(sources, [], [], min(IDLE_TIMEOUT, remaining))
        if not readable:
            return
        for source in readable:
            data = source.recv(65536)
            if data:
                peers[source].sendall(data)
            else:
                sources.remove(source)
                try:
                    peers[source].shutdown(socket.SHUT_WR)
                except OSError:
                    pass


class Handler(socketserver.BaseRequestHandler):
    def reply(self, status):
        self.request.sendall(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").encode("ascii"))

    def handle(self):
        upstream = None
        established = False
        try:
            self.request.settimeout(10)
            header = bytearray()
            while b"\r\n\r\n" not in header:
                chunk = self.request.recv(min(4096, MAX_HEADER + 1 - len(header)))
                if not chunk:
                    return
                header.extend(chunk)
                if len(header) > MAX_HEADER:
                    self.reply("431 Request Header Fields Too Large")
                    return
            request_header, early_data = bytes(header).split(b"\r\n\r\n", 1)
            line = request_header.split(b"\r\n", 1)[0].decode("ascii")
            request = re.fullmatch(r"CONNECT ([^ ]+) HTTP/1\.[01]", line)
            if not request:
                self.reply("405 Method Not Allowed")
                return
            host = allowed_authority(request.group(1))
            if not host:
                self.reply("403 Forbidden")
                return
            upstream = open_upstream(host)
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            established = True
            if early_data:
                upstream.sendall(early_data)
            relay(self.request, upstream)
        except (OSError, UnicodeError, ValueError):
            if not established:
                try:
                    self.reply("502 Bad Gateway")
                except OSError:
                    pass
        finally:
            if upstream is not None:
                upstream.close()


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # socketserver's default traceback includes client/request context.
        # Keep all network requests and encrypted bytes out of the journal.
        pass


if __name__ == "__main__":
    with Server(BIND, Handler) as server:
        print("CI TLS tunnel listening on loopback", flush=True)
        server.serve_forever(poll_interval=0.5)
