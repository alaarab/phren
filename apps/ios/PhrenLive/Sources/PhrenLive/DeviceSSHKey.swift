import Crypto
import Foundation
import NIOSSH
import PhrenKit
import Security

/// A separate key per host; private bytes never enter preferences, logs, Git,
/// iCloud Keychain, or backups. Every operation goes through the dispatcher;
/// SSH forwarding would also grant access to private Unix sockets.
public enum DeviceSSHKey {
    private static func query(_ id: UUID) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.phren.ios.live-ssh",
         kSecAttrAccount as String: id.uuidString]
    }

    public static func load(_ id: UUID) throws -> Data {
        var attributes = query(id)
        attributes[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            throw PhrenKitError.validation("This device's SSH key is unavailable (\(status)). Open connection settings to create a new key if needed.")
        }
        return data
    }

    public static func publicKey(_ id: UUID) throws -> String {
        var attributes = query(id)
        attributes[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        let key: Curve25519.Signing.PrivateKey
        if status == errSecItemNotFound {
            key = Curve25519.Signing.PrivateKey()
            var item = query(id)
            item[kSecValueData as String] = key.rawRepresentation
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let saved = SecItemAdd(item as CFDictionary, nil)
            guard saved == errSecSuccess else { throw PhrenKitError.validation("Could not save the SSH key (\(saved)).") }
        } else {
            guard status == errSecSuccess, let data = result as? Data else {
                throw PhrenKitError.validation("Could not read the SSH key (\(status)).")
            }
            key = try Curve25519.Signing.PrivateKey(rawRepresentation: data)
        }
        return authorizedKey(privateKey: key)
    }

    static func authorizedKey(privateKey: Curve25519.Signing.PrivateKey) -> String {
        let publicKey = String(openSSHPublicKey: NIOSSHPrivateKey(ed25519Key: privateKey).publicKey)
        return "restrict,pty,command=\"sh ~/.local/share/phren/bridge/dispatch\" \(publicKey) phren-iphone"
    }

    public static func delete(_ id: UUID) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PhrenKitError.validation("Could not remove this device's SSH key (\(status)).")
        }
    }
}
