import Foundation

public struct APIError: LocalizedError, Sendable {
    public let status: Int; public let code: String; public let message: String
    public init(status: Int, code: String, message: String) { self.status = status; self.code = code; self.message = message }
    public var errorDescription: String? { message }
}
private struct ErrorEnvelope: Decodable { struct Detail: Decodable { let code: String; let message: String }; let error: Detail }
public actor APIClient {
    public private(set) var baseURL: URL
    private let transport: URLSession
    private var session: Session?
    private var refreshTask: Task<Session, Error>?
    private let persistSession: Bool
    private let storage: SessionStorage
    private var sessionGeneration: UInt64 = 0
    private struct Restoration { let id: UUID; let generation: UInt64; let task: Task<Session?, Error> }
    private var restoration: Restoration?
    private var restorationAttempted = false
    private var restorationError: APIError?
    private var persistenceTask: Task<Void, Error>?
    public init(baseURL: URL, transport: URLSession = .shared, persistSession: Bool = true, sessionStorage: SessionStorage = .keychain) {
        self.baseURL = baseURL; self.transport = transport; self.persistSession = persistSession; self.storage = sessionStorage
    }
    public static func validatedURL(_ text: String) throws -> URL {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)) else {
            throw APIError(status: 0, code: "invalid_server", message: "请输入 HTTPS 服务器地址；本机开发可用 http://127.0.0.1:8787")
        }
        return URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/")))!
    }
    public func configure(_ url: URL) {
        guard url != baseURL else { return }
        invalidateRestoration(); baseURL = url; session = nil
    }
    public func currentSession() -> Session? { session }
    private func invalidateRestoration() {
        // SecItemCopyMatching cannot be reliably cancelled. Keep its occupied
        // slot until the original waiter finishes instead of spawning more reads.
        sessionGeneration &+= 1; restoration?.task.cancel()
        restorationAttempted = false; restorationError = nil
    }
    /// Called after the window appears, never from an initializer. Concurrent
    /// callers share one background read; a later login/configure wins over it.
    public func restoreSession(allowInteraction: Bool = false) async throws -> Session? {
        guard persistSession else { return session }
        if session != nil { return session }
        if let restoration, restoration.generation != sessionGeneration {
            throw APIError(status: 0, code: "session_restore_pending", message: "系统仍未完成先前的安全存储请求。请直接重新登录；不会重复读取或删除旧凭据。")
        }
        if restorationAttempted && !allowInteraction {
            if let restorationError { throw restorationError }; return session
        }
        let pending: Restoration
        if let restoration { pending = restoration }
        else {
            let origin = baseURL.absoluteString, read = storage.read
            pending = Restoration(id: UUID(), generation: sessionGeneration, task: Task.detached(priority: .userInitiated) { try read(origin, allowInteraction) })
            restoration = pending
        }
        do {
            let loaded = try await pending.task.value
            guard sessionGeneration == pending.generation else { if restoration?.id == pending.id { restoration = nil }; return session }
            if restoration?.id == pending.id { session = loaded; restoration = nil; restorationAttempted = true; restorationError = nil }
            return session
        } catch {
            guard sessionGeneration == pending.generation else { if restoration?.id == pending.id { restoration = nil }; return session }
            let failure: APIError
            if let keychain = error as? SecureSessionStore.StoreError, keychain.requiresInteraction {
                failure = APIError(status: 0, code: "session_access_required", message: "系统需要你允许访问已保存登录。可以点击恢复，或直接重新登录；旧凭据会保留。")
            } else { failure = APIError(status: 0, code: "session_restore_unavailable", message: "暂时无法读取已保存登录。可以重试恢复，或直接重新登录；旧凭据会保留。") }
            if restoration?.id == pending.id { restoration = nil; restorationAttempted = true; restorationError = failure }
            throw failure
        }
    }
    public func cancelSessionRestoration() { invalidateRestoration(); restorationAttempted = true }
    private func persist(_ operation: @escaping @Sendable () throws -> Void) async throws {
        let previous = persistenceTask
        let work = Task.detached(priority: .userInitiated) { _ = try? await previous?.value; try operation() }
        persistenceTask = work; try await work.value
    }
    public func setSession(_ value: Session) async throws {
        invalidateRestoration(); let generation = sessionGeneration, origin = baseURL.absoluteString
        if persistSession { let write = storage.write; try await persist { try write(value, origin) } }
        guard generation == sessionGeneration else { throw CancellationError() }
        session = value; restorationAttempted = true
    }
    public func clearSession() async {
        invalidateRestoration(); session = nil; restorationAttempted = true
        if persistSession { let origin = baseURL.absoluteString, remove = storage.remove; try? await persist { remove(origin) } }
    }
    public func loginDevelopment(email: String, name: String) async throws -> Session {
        let result: Session = try await request("/auth/dev", method: "POST", body: ["email": .string(email), "name": .string(name)], authenticated: false)
        try await setSession(result); return result
    }
    public func exchange(accessToken: String) async throws -> Session {
        let result: Session = try await request("/auth/exchange", method: "POST", body: ["access_token": .string(accessToken)], authenticated: false)
        try await setSession(result); return result
    }
    /// Read the current server version immediately before revoking; never trust an old UI snapshot.
    public func revokeDevice(id: String) async throws {
        let devices: Items<Device> = try await request("/devices")
        guard let device = devices.items.first(where: { $0.id == id }) else { throw APIError(status: 404, code: "device_not_found", message: "电脑记录已变化，请刷新后重试") }
        if device.revoked == true { return }
        let _: JSONValue = try await request("/devices/\(id)", method: "DELETE", version: device.version)
    }
    public func logout() async {
        let _: JSONValue? = try? await request("/auth/logout", method: "POST", body: [:])
        await clearSession()
    }
    public func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: [String: JSONValue]? = nil, version: Int? = nil, authenticated: Bool = true, idempotencyKey: String? = nil) async throws -> T {
        let key = idempotencyKey ?? (method == "POST" ? UUID().uuidString : nil)
        do { return try await perform(path, method: method, body: body, version: version, authenticated: authenticated, key: key) }
        catch let error as APIError where error.status == 401 && authenticated && session != nil {
            try await refresh()
            return try await perform(path, method: method, body: body, version: version, authenticated: authenticated, key: key)
        }
    }
    private func refresh() async throws {
        if let task = refreshTask { _ = try await task.value; return }
        guard let token = session?.refreshToken else { throw APIError(status: 401, code: "signed_out", message: "会话已失效，请重新登录") }
        let generation = sessionGeneration
        let task = Task<Session, Error> {
            let result: Session = try await self.perform("/auth/refresh", method: "POST", body: ["refresh_token": .string(token)], version: nil, authenticated: false, key: nil)
            guard self.sessionGeneration == generation else { throw CancellationError() }
            try await self.setSession(result); return result
        }
        refreshTask = task
        defer { refreshTask = nil }
        do { _ = try await task.value }
        catch { if sessionGeneration == generation { await clearSession() }; throw error }
    }
    private func perform<T: Decodable & Sendable>(_ path: String, method: String, body: [String: JSONValue]?, version: Int?, authenticated: Bool, key: String?) async throws -> T {
        guard path.hasPrefix("/"), !path.contains("://"), let url = URL(string: baseURL.absoluteString + "/v1" + path) else { throw APIError(status: 0, code: "invalid_path", message: "无效接口地址") }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.timeoutInterval = 25
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated {
            guard let session else { throw APIError(status: 401, code: "signed_out", message: "请先登录") }
            request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        if let version { request.setValue("\"\(version)\"", forHTTPHeaderField: "If-Match") }
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError(status: 0, code: "network", message: "服务器未返回 HTTP 响应") }
        guard (200..<300).contains(response.statusCode) else {
            let detail = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw APIError(status: response.statusCode, code: detail?.error.code ?? "http_error", message: detail?.error.message ?? "请求失败（\(response.statusCode)）")
        }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        if data.isEmpty || response.statusCode == 204 {
            if T.self == EmptyResponse.self { return EmptyResponse() as! T }
            return try decoder.decode(T.self, from: Data("{}".utf8))
        }
        return try decoder.decode(T.self, from: data)
    }
}
