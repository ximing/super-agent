import Foundation

/// A local, short-lived form value. Never log this value or send it without an explicit Connect action.
public struct RecallConnectionImport: Sendable {
    public static let maximumBytes = 32 * 1024
    public let url: String
    public let token: String
    public static func decode(_ data: Data) throws -> RecallConnectionImport {
        guard data.count <= maximumBytes else { throw APIError(status: 0, code: "recall_import_size", message: "配置文件过大，请选择不超过 32 KiB 的 JSON 文件") }
        struct Input: Decodable { let url: String; let token: String }
        guard let input = try? JSONDecoder().decode(Input.self, from: data),
              let address = URL(string: input.url), address.scheme == "https", let host = address.host, !host.isEmpty,
              address.user == nil, address.password == nil, address.query == nil, address.fragment == nil,
              !input.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              input.token.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw APIError(status: 0, code: "recall_import_invalid", message: "配置文件无效，需要有效的 HTTPS 地址和访问令牌")
        }
        return RecallConnectionImport(url: address.absoluteString, token: input.token)
    }
}
