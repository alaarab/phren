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

    init(directory: URL) { self.directory = directory }

    func load(hosts: [LiveHost], preferences: LiveSessionPreferences?, query: String,
              focusFilter: AgentFocusFilter?, now: Date = .now) -> Record? {
        guard let url = file(hosts), let data = try? Data(contentsOf: url), data.count <= 8_388_608,
              let record = try? JSONDecoder().decode(Record.self, from: data), record.version == 1,
              (0..<60).contains(now.timeIntervalSince(record.savedAt)),
              record.hosts.map(\.host).sorted(by: Self.ordered) == hosts.sorted(by: Self.ordered),
              record.preferences == preferences, record.screen.query == query, record.screen.focusFilter == focusFilter
        else { return nil }
        // Do not revive the green status of a snapshot that aged out while
        // the process was gone, even if the cached screen was recently saved.
        guard record.hosts.allSatisfy({ host in
            record.screen.computers.first { $0.id == host.host.id }?.fresh != true
                || host.lastUpdated.map { now.timeIntervalSince($0) < 90 } == true
        }) else { return nil }
        return record
    }

    func save(_ record: Record, force: Bool = false) {
        guard let url = file(record.hosts.map(\.host)) else { return }
        // Polls with an unchanged screen still renew its age, at most twice a minute.
        if let previous = lastWrite[url.lastPathComponent] {
            guard record.savedAt >= previous else { return }
            if !force, record.savedAt.timeIntervalSince(previous) < 30 { return }
        }
        guard let data = try? JSONEncoder().encode(record), data.count <= 8_388_608 else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            lastWrite[url.lastPathComponent] = record.savedAt
        } catch { /* A cache failure must never hold up live discovery. */ }
    }

    private static func ordered(_ lhs: LiveHost, _ rhs: LiveHost) -> Bool { lhs.id.uuidString < rhs.id.uuidString }
    private func file(_ hosts: [LiveHost]) -> URL? {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(hosts.sorted(by: Self.ordered)) else { return nil }
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(key + ".json")
    }
}
