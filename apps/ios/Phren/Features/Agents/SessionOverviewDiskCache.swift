import CryptoKit
import Foundation
import PhrenKit

/// A complete render value, never a series of independently restored hosts.
/// Encoding and file I/O run on this actor, away from the UI actor.
actor SessionOverviewDiskCache {
    struct HostSnapshot: Codable {
        let host: LiveHost
        let snapshot: LiveWorkspaces?
        let lastUpdated: Date?
    }
    struct Record: Codable {
        var version = 1
        let savedAt: Date
        let hosts: [HostSnapshot]
        let screen: SessionOverviewMonitor.Screen
        let preferences: LiveSessionPreferences?
    }
    static let shared = SessionOverviewDiskCache(directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent(AppRuntime.isUITesting ? "session-overview-tests" : "session-overview", isDirectory: true))
    private let directory: URL
    private var lastWrite: [String: Date] = [:]
    private var forgottenHosts: Set<UUID> = []

    init(directory: URL) { self.directory = directory }

    func load(hosts: [LiveHost], preferences: LiveSessionPreferences?,
              focusFilter: AgentFocusFilter?, now: Date = .now) -> Record? {
        guard hosts.allSatisfy({ !forgottenHosts.contains($0.id) }), let url = file(hosts), let data = try? Data(contentsOf: url), data.count <= 8_388_608,
              let record = try? JSONDecoder().decode(Record.self, from: data), record.version == 1,
              (0..<Self.lastKnownAge).contains(now.timeIntervalSince(record.savedAt)),
              record.hosts.map(\.host).sorted(by: Self.ordered) == hosts.sorted(by: Self.ordered),
              record.preferences == preferences, record.screen.focusFilter == focusFilter
        else { return nil }
        // A screen saved within the minute shows as it was. An older one is
        // still the last known list, which beats a blank page on a cold
        // launch, but it never revives a green status: every computer reads
        // as connecting and every group as stale until its answer lands.
        let current = now.timeIntervalSince(record.savedAt) < 60 && record.hosts.allSatisfy({ host in
            record.screen.computers.first { $0.id == host.host.id }?.fresh != true
                || host.lastUpdated.map { now.timeIntervalSince($0) < 90 } == true
        })
        if current { return record }
        var stale = record.screen
        stale.groups = stale.groups.map { .init(id: $0.id, title: $0.title, sessions: $0.sessions, fresh: false) }
        stale.computers = stale.computers.map {
            var row = SessionOverviewMonitor.ComputerRow(host: $0.host, connecting: true, fresh: false, message: nil,
                                                         needsVerification: $0.needsVerification)
            row.slow = $0.slow
            return row
        }
        return Record(version: record.version, savedAt: record.savedAt, hosts: record.hosts, screen: stale, preferences: record.preferences)
    }
    /// How long the last rendered list may stand in for a cold launch.
    static let lastKnownAge: TimeInterval = 86_400

    func save(_ record: Record, force: Bool = false) {
        guard record.hosts.allSatisfy({ !forgottenHosts.contains($0.host.id) }), let url = file(record.hosts.map(\.host)) else { return }
        // Polls with an unchanged screen still renew its age, at most twice a minute.
        if let previous = lastWrite[url.lastPathComponent] {
            guard record.savedAt >= previous else { return }
            if !force, record.savedAt.timeIntervalSince(previous) < 30 { return }
        }
        guard let data = try? JSONEncoder().encode(record), data.count <= 8_388_608 else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            lastWrite[url.lastPathComponent] = record.savedAt
        } catch { /* A cache failure must never hold up live discovery. */ }
    }

    /// Also reject an in-flight save captured before Forget. Removing one
    /// computer invalidates every hosts-set render value in this directory.
    func purge(forgetting hostID: UUID) throws {
        forgottenHosts.insert(hostID)
        lastWrite.removeAll()
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    private static func ordered(_ lhs: LiveHost, _ rhs: LiveHost) -> Bool { lhs.id.uuidString < rhs.id.uuidString }
    private func file(_ hosts: [LiveHost]) -> URL? {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(hosts.sorted(by: Self.ordered)) else { return nil }
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(key + ".json")
    }
}
