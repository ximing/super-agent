import Foundation
import Security
import LocalAuthentication

/// Injectable storage boundary. Construction never calls these closures.
public struct SessionStorage: Sendable {
    public let read: @Sendable (String, Bool) throws -> Session?
    public let write: @Sendable (Session, String) throws -> Void
    public let remove: @Sendable (String) -> Void
    public init(read: @escaping @Sendable (String, Bool) throws -> Session?, write: @escaping @Sendable (Session, String) throws -> Void, remove: @escaping @Sendable (String) -> Void) { self.read = read; self.write = write; self.remove = remove }
    public static let keychain = SessionStorage(read: { try SecureSessionStore.read(origin: $0, allowInteraction: $1) }, write: { try SecureSessionStore.write($0, origin: $1) }, remove: { SecureSessionStore.remove(origin: $0) })
}

public enum SecureSessionStore {
    private static let service = "com.superagent.control.session"
    public static func read(origin: String, allowInteraction: Bool = false) throws -> Session? {
        let context = LAContext(); context.interactionNotAllowed = !allowInteraction
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne, kSecUseAuthenticationContext as String: context]
        // Retain the legacy-keychain search semantics/ACL. This per-query flag
        // also suppresses old item access dialogs until the user asks to restore.
        if !allowInteraction { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
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
    struct StoreError: LocalizedError { let code: OSStatus; init(_ code: OSStatus) { self.code = code }; var requiresInteraction: Bool { [errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled].contains(code) }; var errorDescription: String? { "无法访问安全会话存储（\(code)）" } }
}
