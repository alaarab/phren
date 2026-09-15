#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit

extension SessionOverviewMonitor {
    /// Seeds the real disk path, including expiry, without a live computer.
    func seedCacheFixture(_ cache: SessionOverviewDiskCache, hosts: [LiveHost]) async {
        let args = ProcessInfo.processInfo.arguments
        guard AppRuntime.isUITesting, args.contains("--overview-cache-fresh") || args.contains("--overview-cache-expired") else { return }
        let date = Date.now.addingTimeInterval(args.contains("--overview-cache-expired") ? -61 : -5)
        var snapshots: [SessionOverviewDiskCache.HostSnapshot] = []
        var groups: [Group] = []
        for host in hosts {
            // A previousUpdate skips the artificial first-response delay; the
            // subsequent real monitor refresh still exercises that delay.
            guard let snapshot = try? await LiveHostMonitor.fetch(host, previousUpdate: date) else { return }
            snapshots.append(.init(host: host, snapshot: snapshot, lastUpdated: date))
            for session in snapshot.sessions(on: host) {
                let title = session.tab.activity == .waiting ? "Needs input" : session.tab.activity.rawValue
                if let index = groups.firstIndex(where: { $0.title == title }) {
                    let old = groups[index]
                    groups[index] = Group(id: old.id, title: title, sessions: old.sessions + [session], fresh: true)
                } else { groups.append(Group(id: session.tab.activity.rawValue, title: title, sessions: [session], fresh: true)) }
            }
        }
        let order = ["Working", "Waiting", "Error", "Done", "Idle", "Unknown"]
        groups.sort { (order.firstIndex(of: $0.id) ?? 6) < (order.firstIndex(of: $1.id) ?? 6) }
        let screen = Screen(groups: groups, computers: hosts.map {
            .init(host: $0, connecting: false, fresh: true, message: nil, needsVerification: false)
        })
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        await cache.save(.init(savedAt: date, hosts: snapshots, screen: screen, preferences: preferences), force: true)
    }
}
#endif
