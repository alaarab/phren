import Foundation

/// A booted iOS simulator on a computer, as Phren Hook lists it.
public struct HostSimulator: Equatable, Sendable, Identifiable, Decodable {
    public let udid: String
    public let name: String
    public let runtime: String
    public var id: String { udid }
    public init(udid: String, name: String, runtime: String) { self.udid = udid; self.name = name; self.runtime = runtime }

    public static func readSnapshot(_ data: Data) throws -> [Self] {
        guard data.count <= 262_144 else { throw PhrenKitError.validation("The simulator list is too large.") }
        struct Snapshot: Decodable { var simulators: [HostSimulator] }
        let list = try JSONDecoder().decode(Snapshot.self, from: data).simulators
        let valid = list.filter { $0.udid.range(of: #"^[A-F0-9-]{36}$"#, options: [.regularExpression, .caseInsensitive]) != nil && !$0.name.isEmpty }
        return Array(valid.prefix(16))
    }
}

/// An app installed on a simulator, for the launcher.
public struct SimulatorApp: Equatable, Sendable, Identifiable, Decodable {
    public let bundleId: String
    public let name: String
    public var id: String { bundleId }
    public init(bundleId: String, name: String) { self.bundleId = bundleId; self.name = name }
    public static func readSnapshot(_ data: Data) throws -> [Self] {
        guard data.count <= 262_144 else { throw PhrenKitError.validation("The app list is too large.") }
        struct Snapshot: Decodable { var apps: [SimulatorApp] }
        return Array(try JSONDecoder().decode(Snapshot.self, from: data).apps.prefix(100))
    }
}

/// A file the phone put on a computer through Phren Hook.
public struct HostFile: Equatable, Sendable, Identifiable, Decodable {
    public let name: String
    public let path: String
    public let size: Int
    public let modified: String
    public var id: String { path }
    public init(name: String, path: String, size: Int, modified: String) { self.name = name; self.path = path; self.size = size; self.modified = modified }
    public var modifiedDate: Date? { ISO8601Dates.parse(modified) }

    public static func readSnapshot(_ data: Data) throws -> [Self] {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The file list is too large.") }
        struct Snapshot: Decodable { var files: [HostFile] }
        return Array(try JSONDecoder().decode(Snapshot.self, from: data).files.filter { $0.path.hasPrefix("/") && !$0.name.isEmpty }.prefix(200))
    }
    public static func uploadedPath(_ data: Data) throws -> String {
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["ok"] as? Bool == true,
              let path = result["path"] as? String, path.hasPrefix("/") else { throw PhrenKitError.validation("The computer did not accept the file.") }
        return path
    }
}
