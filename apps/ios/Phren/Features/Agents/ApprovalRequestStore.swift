import Foundation
import PhrenKit

/// Private, protected app storage for a cold-launch Live Activity action. No
/// credential or executable input is stored, and claiming consumes the record
/// durably before any network mutation so an ambiguous answer cannot replay.
actor ApprovalRequestStore {
    struct Record: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let actionID: String
        let host: LiveHost
        let target: AgentChatTarget
        let expiresAt: Date
    }
    private let url: URL
    init(url: URL = URL.applicationSupportDirectory.appending(path: "pending-approvals.json")) { self.url = url }

    func save(_ record: Record, now: Date = .now) throws -> Record {
        var records = try read().filter { $0.expiresAt > now }
        if let existing = records.first(where: { $0.target == record.target && $0.actionID == record.actionID }) { return existing }
        records.removeAll { $0.target == record.target }
        guard records.count < 8, record.expiresAt > now else { throw PhrenKitError.validation("This permission request has expired.") }
        records.append(record)
        try write(records)
        return record
    }

    func claim(_ id: String, preferences: LiveSessionPreferences, now: Date = .now) throws -> Record {
        var records = try read()
        guard let index = records.firstIndex(where: { $0.id == id }) else {
            throw PhrenKitError.validation("This permission request is no longer pending.")
        }
        let record = records.remove(at: index)
        try write(records.filter { $0.expiresAt > now })
        guard record.expiresAt > now else { throw PhrenKitError.validation("This permission request has expired.") }
        guard preferences.hosts.contains(record.host), record.target.hostID == record.host.id,
              record.target.muxID == record.host.muxID else {
            throw PhrenKitError.validation("The saved computer changed. Open its current conversation in Phren.")
        }
        return record
    }

    func remove(target: AgentChatTarget? = nil, actionID: String? = nil) throws -> [String] {
        let records = try read()
        let removed = records.filter { (target == nil || $0.target == target) && (actionID == nil || $0.actionID == actionID) }
        let ids = Set(removed.map(\.id))
        try write(records.filter { !ids.contains($0.id) && $0.expiresAt > .now })
        return Array(ids)
    }

    private func read() throws -> [Record] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 65_536 else { throw PhrenKitError.validation("The saved permission requests are invalid.") }
        let records = try JSONDecoder().decode([Record].self, from: Data(contentsOf: url))
        guard records.count <= 8 else { throw PhrenKitError.validation("Too many saved permission requests.") }
        return records
    }
    private func write(_ records: [Record]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(records).write(to: url, options: [.atomic, .completeFileProtection])
        var file = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try file.setResourceValues(values)
    }
}
