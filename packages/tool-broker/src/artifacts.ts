import { constants } from 'node:fs';
import { open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkAbort } from './runtime.js';

const MAX_BYTES = 50 * 1024 * 1024;
type Obj = Record<string, unknown>;
export interface ArtifactOptions {
  resolvePath: (path: string, create: boolean) => Promise<string>;
  request: <T>(path: string, body?: unknown) => Promise<T>;
  signal: AbortSignal;
  assertActive: () => void;
  fetcher?: typeof fetch;
}
function signedUrl(value: unknown): string {
  let url: URL;
  try { if (typeof value !== 'string') throw new Error(); url = new URL(value); } catch { throw new Error('invalid_artifact_transfer_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('artifact_transfer_requires_https');
  return url.href;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 100) throw new Error('invalid_artifact_id');
  return encodeURIComponent(value);
}
/** Product API calls carry run authorization; signed object transfers never do. */
export class ArtifactTools {
  constructor(private readonly options: ArtifactOptions) {}
  private active(): void { this.options.assertActive(); checkAbort(this.options.signal); }
  async list(): Promise<unknown> { this.active(); return this.options.request('/artifacts'); }
  private async transfer(url: string, init: RequestInit): Promise<Response> {
    this.active();
    let response: Response;
    try { response = await (this.options.fetcher ?? fetch)(url, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(120_000)]) }); }
    catch { checkAbort(this.options.signal); throw new Error('artifact_transfer_failed'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`artifact_transfer_http_${response.status}`); }
    return response;
  }
  async download(artifactId: unknown, requestedPath: string): Promise<unknown> {
    this.active();
    const destination = await this.options.resolvePath(requestedPath, true);
    try { if ((await stat(destination)).isDirectory()) throw new Error('artifact_destination_is_directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Use the canonical parent for the temporary file and atomic final rename.
    const parent = await realpath(dirname(destination)), finalPath = join(parent, basename(destination));
    const descriptor = await this.options.request<{url:string}>(`/artifacts/${id(artifactId)}/download`);
    const response = await this.transfer(signedUrl(descriptor.url), { method: 'GET' });
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { await response.body?.cancel(); throw new Error('artifact_too_large_or_invalid_length'); }
    const temporary = join(parent, `.artifact-${randomUUID()}.part`);
    let handle: Awaited<ReturnType<typeof open>> | undefined, bytes = 0;
    const digest = createHash('sha256');
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (!response.body) throw new Error('artifact_download_body_missing');
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value: part } = await reader.read(); if (done) break;
          this.active(); bytes += part.byteLength;
          if (bytes > MAX_BYTES) throw new Error('artifact_too_large');
          digest.update(part); await handle.writeFile(part);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (length !== null && Number(length) !== bytes) throw new Error('artifact_download_incomplete');
      this.active(); await handle.close(); handle = undefined;
      // Recheck the destination after network I/O before committing the local file.
      if (await this.options.resolvePath(requestedPath, true) !== destination) throw new Error('artifact_destination_changed');
      await rename(temporary, finalPath);
      return { id: String(artifactId), path: requestedPath, bytes, sha256: digest.digest('hex') };
    } finally { await handle?.close(); await response.body?.cancel().catch(() => undefined); await rm(temporary, { force: true }); }
  }
  async upload(requestedPath: string, name?: unknown, mime?: unknown): Promise<unknown> {
    this.active();
    const path = await this.options.resolvePath(requestedPath, false), metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('artifact_requires_regular_file');
    if (metadata.size > MAX_BYTES) throw new Error('artifact_too_large');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > MAX_BYTES) throw new Error('artifact_too_large_or_not_regular');
      if (await this.options.resolvePath(requestedPath, false) !== path) throw new Error('artifact_source_changed');
      const chunks: Buffer[] = []; let bytes = 0;
      while (true) {
        this.active(); const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - bytes));
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        bytes += bytesRead; if (bytes > MAX_BYTES) throw new Error('artifact_too_large');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      data = Buffer.concat(chunks, bytes);
    } finally { await file.close(); }
    this.active();
    const fileName = name === undefined ? basename(path) : name;
    const contentType = mime === undefined ? 'application/octet-stream' : mime;
    if (typeof fileName !== 'string' || !fileName.length || fileName.length > 300 || typeof contentType !== 'string' || !contentType.length || contentType.length > 200 || /[\r\n]/.test(contentType)) throw new Error('invalid_artifact_metadata');
    const descriptor = await this.options.request<{artifact_id:string;upload_url:string;upload_headers?:Obj;max_size:number}>('/artifacts/uploads', { name: fileName, mime: contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    if (!Number.isSafeInteger(descriptor.max_size) || data.length > descriptor.max_size) throw new Error('artifact_too_large');
    const headers = new Headers();
    for (const [key, value] of Object.entries(descriptor.upload_headers ?? { 'content-type': contentType })) {
      if (!['content-type', 'content-md5', 'x-amz-checksum-sha256'].includes(key.toLowerCase()) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('unsafe_artifact_upload_headers');
      headers.set(key, value);
    }
    const response = await this.transfer(signedUrl(descriptor.upload_url), { method: 'PUT', headers, body: new Uint8Array(data) });
    await response.body?.cancel(); this.active();
    const artifact = await this.options.request<Obj>(`/artifacts/${id(descriptor.artifact_id)}/finalize`, {});
    return { id: descriptor.artifact_id, name: artifact.name ?? fileName, mime: artifact.mime ?? contentType, size: data.length, status: artifact.status ?? 'ready' };
  }
  async uploadBytes(data: Buffer, name: string, mime: string, evidence?: Obj): Promise<Obj> {
    this.active();
    if (data.length > MAX_BYTES) throw new Error('artifact_too_large');
    if (!name || name.length > 300 || !mime || mime.length > 200 || /[\r\n]/.test(mime)) throw new Error('invalid_artifact_metadata');
    const descriptor = await this.options.request<{ artifact_id: string; upload_url: string; upload_headers?: Obj; max_size: number }>('/artifacts/uploads', { name, mime, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...(evidence ?? {}) });
    if (!Number.isSafeInteger(descriptor.max_size) || data.length > descriptor.max_size) throw new Error('artifact_too_large');
    const headers = new Headers();
    for (const [key, value] of Object.entries(descriptor.upload_headers ?? { 'content-type': mime })) {
      if (!['content-type', 'content-md5', 'x-amz-checksum-sha256'].includes(key.toLowerCase()) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('unsafe_artifact_upload_headers');
      headers.set(key, value);
    }
    const response = await this.transfer(signedUrl(descriptor.upload_url), { method: 'PUT', headers, body: new Uint8Array(data) });
    await response.body?.cancel(); this.active();
    const artifact = await this.options.request<Obj>(`/artifacts/${id(descriptor.artifact_id)}/finalize`, {});
    return { id: descriptor.artifact_id, name: artifact.name ?? name, mime: artifact.mime ?? mime, size: data.length, status: artifact.status ?? 'ready' };
  }
}
