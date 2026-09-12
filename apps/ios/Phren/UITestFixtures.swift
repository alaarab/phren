#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit

/// Native interaction fixtures are compiled only for Debug simulators. They
/// build isolated stores; AppModel remains responsible for installing state.
@MainActor
enum UITestFixtures {
    enum Bootstrap {
        case agentsOnly
        case memory([StoreContext])
    }

    private static let hostIDs = [
        UUID(uuidString: "A1000000-0000-0000-0000-000000000001")!,
        UUID(uuidString: "A1000000-0000-0000-0000-000000000002")!,
    ]
    private static let preferencesKey = "sessions.live.preferences.v1"

    static func bootstrap() async throws -> Bootstrap {
        let arguments = ProcessInfo.processInfo.arguments
        let defaults = AppRuntime.defaults
        if arguments.contains("--session-pins-reset"), let saved = defaults.data(forKey: preferencesKey) {
            var data = saved
            for id in try LiveSessionPreferences.read(saved).pinnedSessions {
                data = try LiveSessionPreferences.setPinned(false, for: id, in: data)
            }
            defaults.set(data, forKey: preferencesKey)
        }
        if arguments.contains("--agents-without-github") {
            defaults.set(try LiveSessionPreferences.saving(mac(), in: Data()), forKey: preferencesKey)
            return .agentsOnly
        }

        // Keep discovery fixtures from changing later tests' connection setup.
        if !arguments.contains("--automatic-sessions-fixture"),
           let data = defaults.data(forKey: preferencesKey),
           let saved = try? LiveSessionPreferences.read(data) {
            var cleaned = data
            for id in hostIDs where saved.hosts.contains(where: { $0.id == id }) {
                cleaned = try LiveSessionPreferences.removing(id, from: cleaned)
            }
            if cleaned != data { defaults.set(cleaned, forKey: preferencesKey) }
        }
        if arguments.contains("--workflow-fixture") {
            defaults.set("Queue", forKey: "tasks.section.v1")
            defaults.set("Task order", forKey: "tasks.sort.v1")
        }

        var contexts: [StoreContext] = []
        for owner in ["sample", "team"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ui-tests-\(UUID().uuidString)")
            let store = try LocalStore(rootDirectory: directory, owner: owner, repo: "brain", branch: "main")
            try await store.write("demo/FINDINGS.md", content: "# Findings\n\n- [pattern] Cache repeated requests for offline use\n- [decision] Connect the phone graph to desktop memory\n", blobSha: nil)
            try await store.write("demo/skills/audit.md", content: SkillFile.template(name: "audit", description: "Review the project", instructions: "Run the checks."), blobSha: nil)
            if arguments.contains("--project-skills-fixture") {
                try await store.write("global/skills/review-style.md", content: SkillFile.template(name: "review-style", description: "Review shared style", instructions: "Use clear names."), blobSha: nil)
                try await store.write("other/skills/other-check.md", content: SkillFile.template(name: "other-check", description: "Review another project", instructions: "Check the other project."), blobSha: nil)
            }
            if owner == "sample", arguments.contains("--automatic-sessions-fixture") {
                let savedPins = (try? LiveSessionPreferences.read(defaults.data(forKey: preferencesKey) ?? Data()))?.pinnedSessions ?? []
                try await store.write("phone/FINDINGS.md", content: "# Findings\n\n- [decision] Keep phone sessions connected to project memory\n", blobSha: nil)
                defaults.set(try LiveSessionPreferences.saving(mac(), in: Data()), forKey: preferencesKey)
                if arguments.contains("--all-sessions-fixture") {
                    let remote = try LiveHost(id: hostIDs[1], name: "Test Linux",
                                             address: "remote.fixture.invalid", username: "fixture",
                                             fingerprint: "SHA256:" + String(repeating: "B", count: 43))
                    defaults.set(try LiveSessionPreferences.saving(remote, in: defaults.data(forKey: preferencesKey)!),
                                 forKey: preferencesKey)
                }
                var restored = defaults.data(forKey: preferencesKey)!
                let fixtureHosts = try LiveSessionPreferences.read(restored).hosts
                for id in savedPins where fixtureHosts.contains(where: { $0.id == id.hostID && $0.muxID == id.muxID }) {
                    restored = try LiveSessionPreferences.setPinned(true, for: id, in: restored)
                }
                defaults.set(restored, forKey: preferencesKey)
            }
            if arguments.contains("--workflow-fixture") {
                try await populateWorkflow(store, owner: owner)
            }
            // A fresh tokenless client refuses before making any request.
            let engine = SyncEngine(client: GitHubClient(), store: store, stateDirectory: directory)
            contexts.append(StoreContext(descriptor: StoreDescriptor(owner: owner, name: "brain", branch: "main", canPush: true), store: store, engine: engine))
        }
        return .memory(contexts)
    }

    private static func mac() throws -> LiveHost {
        try LiveHost(id: hostIDs[0], name: "Test Mac", address: "fixture.invalid", username: "fixture",
                     fingerprint: "SHA256:" + String(repeating: "A", count: 43))
    }

    private static func populateWorkflow(_ store: LocalStore, owner: String) async throws {
        let longTask = "Large migration plan. " + String(repeating: "Update the shared modules and verify behavior across projects. ", count: 18) + "END OF PLAN"
        try await store.write("demo/tasks.md", content: """
        # Demo tasks
        ## Active
        ## Queue
        - [ ] \(longTask) [high] <!-- bid:dead0001 created:2026-01-01T12:00:00.000Z -->
          Context: Keep the full plan available from task details.
        - [ ] A short follow-up task <!-- bid:dead0002 created:\(Date().ISO8601Format()) -->
        - [ ] Check the finished app <!-- bid:dead0003 -->
        ## Done
        """, blobSha: nil)
        try await store.write("demo/review.md", content: """
        # Review
        ## Review
        - [2026-09-06] Candidate for \(owner) memory
        - [2026-09-06] Another candidate for \(owner) memory
        ## Stale
        - [2026-09-05] Recheck an older convention
        """, blobSha: nil)
    }
}
#endif
