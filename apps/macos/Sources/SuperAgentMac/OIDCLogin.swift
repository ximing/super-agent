import Foundation
import AppKit
import AuthenticationServices
import CryptoKit
import Security
import SuperAgentCore

enum LoginBrowserMode { case system, external }

/// Only fixed, non-secret stage labels are exposed to the workspace.
enum LoginPhase: String {
    case configure, discovery, openBrowser, openExternalBrowser, waitCallback, tokenExchange, productSession, loadingWorkspace
    var message: String {
        switch self {
        case .configure: return "正在读取登录配置"
        case .discovery: return "正在连接身份服务"
        case .openBrowser: return "正在打开系统安全登录"
        case .openExternalBrowser: return "正在打开默认浏览器登录"
        case .waitCallback: return "等待你在浏览器完成登录；首次登录可能需要修改临时密码"
        case .tokenExchange: return "正在验证登录授权"
        case .productSession: return "正在建立工作台会话"
        case .loadingWorkspace: return "正在加载工作台"
        }
    }
}
@MainActor private final class LoginPresentation: NSObject, ASWebAuthenticationPresentationContextProviding {
    let window: NSWindow
    init(window: NSWindow) { self.window = window }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window }
}
@MainActor final class OIDCLogin: NSObject {
    private var browser: ASWebAuthenticationSession?
    private var presentation: LoginPresentation?
    private var callback: CheckedContinuation<URL, Error>?
    private var callbackID: UUID?
    private var externalCallback: OIDCPendingCallback?
    private var callbackTimeout: Task<Void, Never>?
    private let transport: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config)
    }()
    func cancel(id: UUID? = nil) {
        guard let current = callbackID, id == nil || id == current else { return }
        let active = browser
        finish(.failure(CancellationError()), id: current)
        active?.cancel()
    }
    private func finish(_ result: Result<URL, Error>, id: UUID) {
        guard callbackID == id, let waiting = callback else { return }
        callbackTimeout?.cancel(); callbackTimeout = nil
        callback = nil; callbackID = nil; externalCallback = nil
        waiting.resume(with: result)
    }
    func handleCallback(_ url: URL) {
        guard let id = callbackID, var pending = externalCallback else { return }
        // In particular, a late callback from an old AS session cannot terminate a new attempt.
        guard let _ = try? pending.accept(url) else { return }
        externalCallback = pending
        finish(.success(url), id: id)
    }
    func authenticate(config: AuthConfig, mode: LoginBrowserMode = .system, onPhase: @escaping @MainActor (LoginPhase) -> Void) async throws -> String {
        let attemptID = UUID()
        guard let clientId = config.clientId, let issuer = config.issuer else { throw APIError(status: 0, code: "oidc_config", message: "服务器尚未配置 OIDC 登录服务") }
        defer { callbackTimeout?.cancel(); callbackTimeout = nil; browser = nil; presentation = nil; externalCallback = nil }
        try Task.checkCancellation()
        var authorizationEndpoint = config.authorizationEndpoint
        var tokenEndpoint = config.tokenEndpoint
        if authorizationEndpoint == nil || tokenEndpoint == nil {
            onPhase(.discovery)
            guard let discoveryURL = URL(string: issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/.well-known/openid-configuration") else { throw URLError(.badURL) }
            let (data, response) = try await transport.data(for: URLRequest(url: discoveryURL, timeoutInterval: 20))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(status: 0, code: "oidc_discovery", message: "无法取得登录服务配置") }
            let discovery = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            authorizationEndpoint = discovery?["authorization_endpoint"] as? String
            tokenEndpoint = discovery?["token_endpoint"] as? String
        }
        try Task.checkCancellation()
        guard let authorizationEndpoint, let tokenEndpoint, let tokenURL = URL(string: tokenEndpoint), var components = URLComponents(string: authorizationEndpoint) else { throw URLError(.badURL) }
        let redirect = config.redirectUri ?? "superagent://oauth/callback"
        guard let redirectURL = URL(string: redirect), let callbackScheme = redirectURL.scheme, callbackScheme != "http", callbackScheme != "https" else { throw APIError(status: 0, code: "oidc_redirect", message: "Mac 登录回调需要配置 superagent://oauth/callback") }
        let state = randomToken(); let verifier = randomToken() + randomToken()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "scope", value: "openid profile email"),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "nonce", value: randomToken()),
            URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        guard let authURL = components.url else { throw URLError(.badURL) }
        onPhase(mode == .system ? .openBrowser : .openExternalBrowser)
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first(where: { $0.isVisible }) else { throw APIError(status: 0, code: "login_window", message: "请先打开工作台窗口，再开始登录") }
        presentation = LoginPresentation(window: window)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let callbackURL: URL = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { waiting in
                callback = waiting; callbackID = attemptID
                if mode == .external {
                    externalCallback = OIDCPendingCallback(redirect: redirectURL, state: state)
                    guard NSWorkspace.shared.open(authURL) else { finish(.failure(APIError(status: 0, code: "browser_open", message: "无法打开默认浏览器，请检查浏览器安装后重试")), id: attemptID); return }
                } else {
                let flow = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { [weak self] returnedURL, error in
                    Task { @MainActor in
                        guard let self else { return }
                        if let error {
                            let system = error as NSError
                            if system.domain == ASWebAuthenticationSessionErrorDomain && system.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue {
                                self.finish(.failure(CancellationError()), id: attemptID)
                            } else { self.finish(.failure(error), id: attemptID) }
                        }
                        else if let returnedURL { self.finish(.success(returnedURL), id: attemptID) }
                        else { self.finish(.failure(URLError(.cancelled)), id: attemptID) }
                    }
                }
                flow.presentationContextProvider = presentation
                browser = flow
                guard flow.canStart, flow.start() else { finish(.failure(APIError(status: 0, code: "browser_login", message: "系统未能打开安全登录。请取消后重试，并检查默认浏览器是否可用")), id: attemptID); return }
                }
                onPhase(.waitCallback)
                callbackTimeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(300)) } catch { return }
                    guard let self, self.callbackID == attemptID else { return }
                    let active = self.browser
                    self.finish(.failure(APIError(status: 0, code: "login_timeout", message: "等待浏览器登录已超时，请重新开始登录")), id: attemptID)
                    active?.cancel()
                }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel(id: attemptID) } }
        try Task.checkCancellation()
        let code: String
        switch try OIDCCallbackParser.parse(callbackURL, redirect: redirectURL, state: state) {
        case .authorizationCode(let value): code = value
        case .denied: throw APIError(status: 0, code: "oidc_error", message: "身份服务未完成授权，请在浏览器完成登录后重试")
        }
        onPhase(.tokenExchange)
        var body = URLComponents(); body.queryItems = [
            URLQueryItem(name: "grant_type", value: "authorization_code"), URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "code", value: code), URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "code_verifier", value: verifier)
        ]
        var request = URLRequest(url: tokenURL, timeoutInterval: 20); request.httpMethod = "POST"; request.httpBody = body.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await transport.data(for: request)
        try Task.checkCancellation()
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status), let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let token = result["access_token"] as? String else { throw APIError(status: 0, code: "oidc_token", message: "无法换取登录凭证，请检查 OIDC 回调和客户端配置") }
        return token
    }
    private func randomToken() -> String { var bytes = [UInt8](repeating: 0, count: 32); _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes); return Data(bytes).base64URL }
}
private extension Data { var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } }
