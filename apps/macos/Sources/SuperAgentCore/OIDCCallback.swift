import Foundation

public enum OIDCAuthorizationCallback: Equatable, Sendable {
    case authorizationCode(String)
    case denied
}
/// No URL, authorization code, or state is included in errors.
public enum OIDCCallbackParser {
    public static func parse(_ callback: URL, redirect: URL, state: String) throws -> OIDCAuthorizationCallback {
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let states = query.filter { $0.name == "state" }
        let codes = query.filter { $0.name == "code" }
        let errors = query.filter { $0.name == "error" }
        guard !state.isEmpty, redirect.query == nil, redirect.fragment == nil,
              callback.scheme == redirect.scheme, callback.host == redirect.host,
              callback.path == redirect.path, callback.port == redirect.port,
              callback.user == nil, callback.password == nil, callback.fragment == nil,
              states.count == 1, states[0].value == state, codes.count <= 1, errors.count <= 1 else {
            throw APIError(status: 0, code: "oidc_callback", message: "登录回调校验失败，请重试")
        }
        if errors.count == 1 {
            guard codes.isEmpty, !(errors[0].value ?? "").isEmpty else { throw APIError(status: 0, code: "oidc_callback", message: "登录回调校验失败，请重试") }
            return .denied
        }
        guard codes.count == 1, let code = codes[0].value, !code.isEmpty else { throw APIError(status: 0, code: "oidc_code", message: "登录服务没有返回有效授权码") }
        return .authorizationCode(code)
    }
}
/// Invalid or unsolicited callbacks cannot consume the pending login. A valid one is accepted once.
public struct OIDCPendingCallback: Sendable {
    private var redirect: URL?
    private var state: String?
    public init(redirect: URL? = nil, state: String? = nil) { self.redirect = redirect; self.state = state }
    public mutating func accept(_ callback: URL) throws -> OIDCAuthorizationCallback? {
        guard let redirect, let state else { return nil }
        let value = try OIDCCallbackParser.parse(callback, redirect: redirect, state: state)
        self.redirect = nil; self.state = nil
        return value
    }
}
