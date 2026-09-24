import Foundation
#if canImport(Security)
import Security
#endif

/// GitHub token storage. On Apple platforms this is the Keychain
/// (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — the token never
/// leaves the device or lands in backups). The non-Apple fallback exists only
/// so PhrenKit's parser tests run on Linux CI; the app never uses it.
public enum KeychainStore {
    static let service = "com.phren.ios.github"
    static let account = "github-token"

    public enum TokenKind: String, Codable, Sendable {
        case oauth
        case pat
    }

    public struct StoredToken: Codable, Equatable, Sendable {
        public let token: String
        public let kind: TokenKind
        /// Last verified identity, bound to this credential for offline startup.
        /// Optional so tokens saved by older builds still decode.
        public let user: GitHubUser?
        public init(token: String, kind: TokenKind, user: GitHubUser? = nil) {
            self.token = token
            self.kind = kind
            self.user = user
        }
    }

    /// What a read found. `locked` is not "signed out": before the first
    /// unlock after a restart the Keychain refuses every read
    /// (`errSecInteractionNotAllowed`) although the token is still there, and
    /// iOS can launch the app in the background in that window.
    public enum ReadResult: Equatable, Sendable {
        case found(StoredToken)
        case missing
        case locked
    }

#if canImport(Security)
    public static func save(_ stored: StoredToken) throws {
        let data = try JSONEncoder().encode(stored)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // An interrupted/failed refresh must not erase the working credential.
        var status = SecItemUpdate(query as CFDictionary,
                                   [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = query
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw PhrenKitError.validation("Keychain save failed (\(status)).")
        }
    }

    public static func read() -> ReadResult {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecInteractionNotAllowed { return .locked }
        guard status == errSecSuccess, let data = result as? Data else { return .missing }
        // Deliberately NOT a versioned/quarantined document, unlike everything
        // in Persistence/: this is a credential, not user data. Nothing is
        // lost if it can't be read — the user signs in again and gets a new
        // token — and copying a token to a quarantine file to preserve it
        // would be strictly worse than dropping it.
        guard let stored = try? JSONDecoder().decode(StoredToken.self, from: data) else { return .missing }
        return .found(stored)
    }

    public static func load() -> StoredToken? {
        if case .found(let stored) = read() { return stored }
        return nil
    }

    public static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
#else
    // Linux CI fallback: in-memory only. Never used by the iOS app.
    private final class MemoryBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: StoredToken?
        func get() -> StoredToken? { lock.lock(); defer { lock.unlock() }; return value }
        func set(_ newValue: StoredToken?) { lock.lock(); defer { lock.unlock() }; value = newValue }
    }
    private static let memory = MemoryBox()

    public static func save(_ stored: StoredToken) throws { memory.set(stored) }
    public static func read() -> ReadResult { memory.get().map(ReadResult.found) ?? .missing }
    public static func load() -> StoredToken? { memory.get() }
    public static func delete() { memory.set(nil) }
#endif
}
