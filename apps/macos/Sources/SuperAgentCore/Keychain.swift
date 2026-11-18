import Foundation
import Security

public enum SecureSessionStore {
    private static let service = "com.superagent.control.session"
    public static func read(origin: String) throws -> Session? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StoreError(status) }
        return try JSONDecoder().decode(Session.self, from: data)
    }
    public static func write(_ session: Session, origin: String) throws {
        let data = try JSONEncoder().encode(session)
        let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin]
        let update = SecItemUpdate(key as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var value = key
            value[kSecValueData as String] = data
            value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(value as CFDictionary, nil)
            guard status == errSecSuccess else { throw StoreError(status) }
        } else if update != errSecSuccess { throw StoreError(update) }
    }
    public static func remove(origin: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin] as CFDictionary)
    }
    struct StoreError: LocalizedError { let code: OSStatus; init(_ code: OSStatus) { self.code = code }; var errorDescription: String? { "无法访问安全会话存储（\(code)）" } }
}
