import Foundation
import CryptoKit

public struct AgentAttachment: Equatable, Sendable, Identifiable {
    public let id: UUID
    public let name: String
    public let data: Data
    public let isImage: Bool
    public let uploadName: String
    let contentDigest: String
    public static let maximumBytes = 8 * 1_024 * 1_024

    public init(id: UUID = UUID(), name: String, data: Data, isImage: Bool = false) throws {
        guard !data.isEmpty, data.count <= Self.maximumBytes else {
            throw PhrenKitError.validation("Choose a file smaller than 8 MB.")
        }
        self.id = id; self.data = data; self.isImage = isImage
        contentDigest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        self.name = String(name.filter { !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }.prefix(160))
        let ext = (name as NSString).pathExtension.lowercased()
        let safeExtension = ext.range(of: #"^[a-z0-9]{1,12}$"#, options: .regularExpression) != nil ? ext : "bin"
        uploadName = "phren-\(id.uuidString.lowercased()).\(safeExtension)"
    }

    public static func uploadedPath(from data: Data) throws -> String {
        // Phren Hook 0.2.11 returned a path without an `ok` field after a
        // successful HTTP upload. Accept that protocol-v1 response as well,
        // while rejecting explicit failures and unsafe paths.
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["error"] == nil, value["ok"] == nil || value["ok"] as? Bool == true,
              let path = value["path"] as? String,
              path.hasPrefix("/"), path.utf8.count <= 4_096,
              !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw PhrenKitError.validation("The computer did not return a usable attachment path.")
        }
        return path
    }
}
