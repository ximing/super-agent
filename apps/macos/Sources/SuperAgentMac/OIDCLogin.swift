import Foundation
import AppKit
import AuthenticationServices
import CryptoKit
import Security
import SuperAgentCore

@MainActor final class OIDCLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var browser: ASWebAuthenticationSession?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { NSApp.keyWindow ?? NSApp.windows.first ?? NSWindow() }
    func authenticate(config: AuthConfig) async throws -> String {
        guard let clientId = config.clientId, let issuer = config.issuer else { throw APIError(status: 0, code: "oidc_config", message: "服务器尚未配置 OIDC 登录服务") }
        var authorizationEndpoint = config.authorizationEndpoint
        var tokenEndpoint = config.tokenEndpoint
        if authorizationEndpoint == nil || tokenEndpoint == nil {
            guard let discoveryURL = URL(string: issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/.well-known/openid-configuration") else { throw URLError(.badURL) }
            let (data, response) = try await URLSession.shared.data(from: discoveryURL)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(status: 0, code: "oidc_discovery", message: "无法取得登录服务配置") }
            let discovery = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            authorizationEndpoint = discovery?["authorization_endpoint"] as? String
            tokenEndpoint = discovery?["token_endpoint"] as? String
        }
        guard let authorizationEndpoint, let tokenEndpoint, let tokenURL = URL(string: tokenEndpoint), var components = URLComponents(string: authorizationEndpoint) else { throw URLError(.badURL) }
        let redirect = config.redirectUri ?? "superagent://auth"
        guard let callbackScheme = URL(string: redirect)?.scheme, callbackScheme != "http", callbackScheme != "https" else { throw APIError(status: 0, code: "oidc_redirect", message: "Mac 登录回调需要配置 superagent://auth") }
        let state = randomToken(); let verifier = randomToken() + randomToken()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "scope", value: "openid profile email offline_access"),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "nonce", value: randomToken()),
            URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        guard let authURL = components.url else { throw URLError(.badURL) }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let flow = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { url, error in
                if let error { continuation.resume(throwing: error) }
                else if let url { continuation.resume(returning: url) }
                else { continuation.resume(throwing: URLError(.cancelled)) }
            }
            flow.presentationContextProvider = self
            browser = flow
            if !flow.start() { continuation.resume(throwing: APIError(status: 0, code: "browser_login", message: "无法打开系统登录窗口")) }
        }
        defer { browser = nil }
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard query.first(where: { $0.name == "state" })?.value == state else { throw APIError(status: 0, code: "oidc_state", message: "登录回调校验失败，请重试") }
        if let message = query.first(where: { $0.name == "error_description" || $0.name == "error" })?.value { throw APIError(status: 0, code: "oidc_error", message: message) }
        guard let code = query.first(where: { $0.name == "code" })?.value else { throw APIError(status: 0, code: "oidc_code", message: "登录服务没有返回授权码") }
        var body = URLComponents(); body.queryItems = [
            URLQueryItem(name: "grant_type", value: "authorization_code"), URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "code", value: code), URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "code_verifier", value: verifier)
        ]
        var request = URLRequest(url: tokenURL); request.httpMethod = "POST"; request.httpBody = body.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status), let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let token = result["access_token"] as? String else { throw APIError(status: 0, code: "oidc_token", message: "无法换取登录凭证，请检查 OIDC 回调和客户端配置") }
        return token
    }
    private func randomToken() -> String { var bytes = [UInt8](repeating: 0, count: 32); _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes); return Data(bytes).base64URL }
}
private extension Data { var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } }
