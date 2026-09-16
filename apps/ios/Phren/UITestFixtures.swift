#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit

/// Native interaction fixtures are compiled only for Debug simulators. They
/// build isolated stores; AppModel remains responsible for installing state.
@MainActor
enum UITestFixtures {
    static let sessionActivityDate = Date.now.addingTimeInterval(-125)
    #if DEBUG && targetEnvironment(simulator)
    /// Tabs a UI test closed from the list; the all-sessions fixture leaves
    /// them out of later snapshots the way Herdr would.
    @MainActor static var closedTabs: Set<String> = []
    #endif
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
        defaults.removeObject(forKey: AgentLaunch.pendingKey)
        defaults.removeObject(forKey: AgentLaunch.pendingProjectKey)
        defaults.removeObject(forKey: AgentFocusFilterStore.key)
        if arguments.contains("--session-pins-reset"), let saved = defaults.data(forKey: preferencesKey) {
            var data = saved
            for id in try LiveSessionPreferences.read(saved).pinnedSessions {
                data = try LiveSessionPreferences.setPinned(false, for: id, in: data)
            }
            defaults.set(data, forKey: preferencesKey)
        }
        if arguments.contains("--toolbar-with-room"), (defaults.data(forKey: TerminalToolbarPreferences.storageKey) ?? Data()).isEmpty {
            // The defaults fill every slot; leave one free for a test to add
            // to. Only on a clean slate, so a relaunch keeps what the test added.
            var layout = TerminalToolbarPreferences.defaults
            layout.items.removeAll { $0 == .paste }
            defaults.set(try JSONEncoder().encode(layout), forKey: TerminalToolbarPreferences.storageKey)
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
        // The App Store tour: one store with real-looking projects, named computers.
        let tour = arguments.contains("--store-tour-fixture")
        for owner in tour ? ["sample"] : ["sample", "team"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ui-tests-\(UUID().uuidString)")
            let store = try LocalStore(rootDirectory: directory, owner: owner, repo: "brain", branch: "main")
            if tour {
                try await populateTour(store)
            } else {
            try await store.write("demo/FINDINGS.md", content: "# Findings\n\n- [pattern] Cache repeated requests for offline use\n- [decision] Connect the phone graph to desktop memory\n", blobSha: nil)
            try await store.write("demo/skills/audit.md", content: SkillFile.template(name: "audit", description: "Review the project", instructions: "Run the checks."), blobSha: nil)
            }
            if arguments.contains("--project-skills-fixture") {
                try await store.write("global/skills/review-style.md", content: SkillFile.template(name: "review-style", description: "Review shared style", instructions: "Use clear names."), blobSha: nil)
                try await store.write("other/skills/other-check.md", content: SkillFile.template(name: "other-check", description: "Review another project", instructions: "Check the other project."), blobSha: nil)
            }
            if owner == "sample", arguments.contains("--automatic-sessions-fixture") {
                let savedPins = (try? LiveSessionPreferences.read(defaults.data(forKey: preferencesKey) ?? Data()))?.pinnedSessions ?? []
                if tour {
                    try await store.write("machines.yaml", content: "Mac mini: mac\nomarchy: omarchy\n", blobSha: nil)
                    for profile in ["mac", "omarchy"] {
                        try await store.write("profiles/\(profile).yaml", content: "name: \(profile)\nprojects:\n  - phren\n  - mina\n  - atlas\n", blobSha: nil)
                    }
                } else {
                try await store.write("phone/FINDINGS.md", content: "# Findings\n\n- [decision] Keep phone sessions connected to project memory\n", blobSha: nil)
                // The store knows this computer carries the project, and where.
                try await store.write("machines.yaml", content: "Test Mac: mac\n", blobSha: nil)
                try await store.write("profiles/mac.yaml", content: "name: mac\nprojects:\n  - phone\n", blobSha: nil)
                try await store.write("phone/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/phone\n", blobSha: nil)
                }
                defaults.set(try LiveSessionPreferences.saving(mac(), in: Data()), forKey: preferencesKey)
                if arguments.contains("--all-sessions-fixture") {
                    let remote = try LiveHost(id: hostIDs[1], name: tour ? "omarchy" : "Test Linux",
                                             address: tour ? "omarchy" : "remote.fixture.invalid", username: tour ? "ala" : "fixture",
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
        // Exercise the same persisted pending target a Spotlight intent leaves,
        // including an open arriving before the model finishes bootstrapping.
        if arguments.contains("--spotlight-session-open") || arguments.contains("--spotlight-terminal-open") {
            let host = try mac()
            let snapshot = try await LiveHostMonitor.fetch(host)
            if let session = snapshot.sessions(on: host).first {
                AgentLaunch.setPending(session, destination: arguments.contains("--spotlight-terminal-open") ? .terminal : .chat)
            }
        } else if arguments.contains("--spotlight-project-open") {
            AgentLaunch.setPendingProject(storeID: "team/brain", project: "demo")
        }
        return .memory(contexts)
    }

    private static func mac() throws -> LiveHost {
        let tour = ProcessInfo.processInfo.arguments.contains("--store-tour-fixture")
        return try LiveHost(id: hostIDs[0], name: tour ? "Mac mini" : "Test Mac", address: tour ? "mini" : "fixture.invalid",
                            username: tour ? "ala" : "fixture", fingerprint: "SHA256:" + String(repeating: "A", count: 43))
    }

    /// Three projects with the kind of memory phren keeps, for the App Store
    /// screens: dated findings under their tags, a task list, a skill.
    private static func populateTour(_ store: LocalStore) async throws {
        func finding(_ id: String, _ text: String) -> String { "- \(text) <!-- fid:\(id) --> <!-- created: 2026-09-14 --> <!-- phren:status \"active\" -->\n" }
        try await store.write("phren/FINDINGS.md", content: "# phren Findings\n\n## 2026-09-16\n\n"
            + finding("a1b2c3d4", "[pitfall] XCUITest: reading UIPasteboard from the runner raises the paste prompt and hangs the run — verify copies through an in-app signal instead.")
            + finding("b2c3d4e5", "[decision] Session cards are one flat rounded rectangle under small upper-case section labels; the computer's name sits beside the branch.")
            + "\n## 2026-09-15\n\n"
            + finding("c3d4e5f6", "[pattern] Long chats keep tools compact while scrolling: cache the rendered Markdown per message and load older pages a few at a time.")
            + finding("d4e5f6a7", "[fix] Two Live Activities: the island shows the highest relevanceScore, so the approval activity is 1.0 and the working summary 0.5.")
            + finding("e5f6a7b8", "[convention] Every chat card belongs to the phren card family — a chip for the server, a verb for the tool, rows for the input, never raw JSON.")
            + "\n## 2026-09-12\n\n"
            + finding("f6a7b8c9", "[pitfall] osascript from a launchd agent hangs forever: a background agent can't be prompted for Automation. Use the AX API from a pinned helper.")
            + finding("a7b8c9d0", "[pattern] The overview reveals every computer together after the first response, with an eight-second ceiling for unreachable ones.")
            + "\n## 2026-09-09\n\n"
            + finding("b1c2d3e4", "[decision] Dictation types straight into the message as you speak; Send after dictation is a setting, not the default.")
            + finding("c2d3e4f5", "[pattern] Reads, greps and read-only shell commands fold into one run once three are in a row; a call that changed a file keeps its card.")
            + finding("d3e4f5a6", "[fix] The terminal owns its pan gesture: a finger swipe scrolls, a mouse-aware TUI gets wheel events, never cursor keys.")
            + finding("e4f5a6b7", "[convention] Controls stay at least 44 points; reduce padding and duplicate rows before text size."), blobSha: nil)
        try await store.write("phren/tasks.md", content: """
        # phren tasks

        ## Active

        - [ ] Ship the onboarding flow: first-run screens, GitHub sign-in, add a computer [high] <!-- bid:10a1b2c3 -->
          Context: Keep the first screen to one tap; the sign-in sheet already exists.

        ## Queue

        - [ ] Widget: show the session that needs you most on the Lock Screen <!-- bid:20b2c3d4 -->
        - [ ] Terminal: pinch to change the text size and the remote grid together <!-- bid:30c3d4e5 -->
        - [ ] Siri: "what is Claude doing" answers with the session card <!-- bid:40d4e5f6 -->

        ## Done

        - [x] Inline approvals in chat, with Open terminal beside Deny and Approve <!-- bid:50e5f6a7 -->
        - [x] Account usage rings on the Sessions toolbar <!-- bid:60f6a7b8 -->
        """, blobSha: nil)
        try await store.write("phren/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/phren\n", blobSha: nil)
        try await store.write("phren/skills/design.md", content: SkillFile.template(name: "design", description: "Design pass on a named screen", instructions: "Fix hierarchy, spacing and density against phren's own conventions, then verify on the simulator."), blobSha: nil)
        try await store.write("mina/FINDINGS.md", content: "# mina Findings\n\n## 2026-09-14\n\n"
            + finding("b8c9d0e1", "[pitfall] Widget intents run in the extension process, where the feed log is nil: conform them to LiveActivityIntent so they perform in the app.")
            + finding("c9d0e1f2", "[pattern] Dynamic Type screenshots: content_size accessibility-extra-large, then launch with -seed-demo and the tab to open.")
            + finding("d0e1f2a3", "[decision] Control Center toggles set a state rather than flip one, so a stale widget can never invert the sleep timer.")
            + "\n## 2026-09-10\n\n"
            + finding("e1f2a3b4", "[convention] Stat tiles, entry rows and the goals header switch to vertical stacks at accessibility sizes.")
            + finding("f5a6b7c8", "[fix] A force-quit app keeps a stale feed alarm; the silent push re-arms it on the next launch.")
            + finding("a6b7c8d9", "[pattern] Seed the simulator with twenty days of demo data before any screenshot run."), blobSha: nil)
        try await store.write("mina/tasks.md", content: """
        # mina tasks

        ## Active

        - [ ] Review the deployment: TestFlight build 42 to the family group <!-- bid:70a7b8c9 -->

        ## Queue

        - [ ] Fix the widget timeline after a partner-logged feed <!-- bid:80b8c9d0 -->

        ## Done

        - [x] Silent push wakes the app for CloudKit changes <!-- bid:90c9d0e1 -->
        """, blobSha: nil)
        try await store.write("mina/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/mina\n", blobSha: nil)
        try await store.write("atlas/FINDINGS.md", content: "# atlas Findings\n\n## 2026-09-11\n\n"
            + finding("f2a3b4c5", "[pattern] Batch the geocoder at eight requests a second and cache by rounded coordinate; the map never waits on the network twice.")
            + finding("a3b4c5d6", "[pitfall] Tiles are one sprite sheet: a missing tile is a wrong offset, not a missing file."), blobSha: nil)
        try await store.write("atlas/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/atlas\n", blobSha: nil)
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
