#if DEBUG && targetEnvironment(simulator)
import ActivityKit
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
    private static let hookIDs = [
        UUID(uuidString: "C1000000-0000-0000-0000-000000000001")!,
        UUID(uuidString: "C1000000-0000-0000-0000-000000000002")!,
    ]
    private static let preferencesKey = "sessions.live.preferences.v1"

    private static func endLiveActivities() async {
        for activity in Activity<ApprovalActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
        for activity in Activity<SessionWorkingActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    static func bootstrap() async throws -> Bootstrap {
        let arguments = ProcessInfo.processInfo.arguments
        let defaults = AppRuntime.defaults
        await endLiveActivities()
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
        // The App Store tour and the product video: one store with
        // real-looking projects, named computers. The video's store is the
        // owner's own repo, and it syncs, so the status bar reads live.
        let trailer = arguments.contains("--trailer-fixture")
        let tour = arguments.contains("--store-tour-fixture") || trailer
        // Memory: the primary store carries three projects' worth of findings,
        // notes and tasks and syncs; the team store keeps the demo content
        // and never syncs, so the panel header shows one stale store.
        let memory = arguments.contains("--memory-fixture")
        // Each UI test starts from the same map mode and unfiltered scope, so
        // the remembered Memory settings never leak between tests.
        defaults.removeObject(forKey: "memory.mode.v1")
        defaults.removeObject(forKey: "memory.kinds.v1")
        defaults.removeObject(forKey: "memory.projects.v1")
        let primary = trailer ? "alaarab" : "sample"
        for owner in tour ? [primary] : ["sample", "team"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ui-tests-\(UUID().uuidString)")
            let repo = trailer ? "memory" : "brain"
            let store = try LocalStore(rootDirectory: directory, owner: owner, repo: repo, branch: "main")
            if trailer {
                try await populateTrailer(store)
            } else if tour {
                try await populateTour(store)
            } else if memory, owner == primary {
                try await populateMemory(store)
            } else {
            try await store.write("demo/FINDINGS.md", content: "# Findings\n\n- [pattern] Cache repeated requests for offline use\n- [pattern] Retry sync after reconnecting\n- [decision] Connect the phone graph to desktop memory\n", blobSha: nil)
            try await store.write("demo/skills/audit.md", content: SkillFile.template(name: "audit", description: "Review the project", instructions: "Run the checks."), blobSha: nil)
            }
            if arguments.contains("--project-skills-fixture") {
                try await store.write("global/skills/review-style.md", content: SkillFile.template(name: "review-style", description: "Review shared style", instructions: "Use clear names."), blobSha: nil)
                try await store.write("other/skills/other-check.md", content: SkillFile.template(name: "other-check", description: "Review another project", instructions: "Check the other project."), blobSha: nil)
            }
            if owner == primary, arguments.contains("--schedules-fixture") {
                try await store.write("machines.yaml", content: "Desk: desk\n", blobSha: nil)
                try await store.write("profiles/desk.yaml", content: "name: desk\nprojects:\n  - demo\n  - other\n", blobSha: nil)
                try await store.write("other/FINDINGS.md", content: "# Findings\n", blobSha: nil)
                try await store.write("demo/schedules.yaml", content: Self.demoSchedules, blobSha: nil)
                try await store.write("other/schedules.yaml", content: Self.otherSchedules, blobSha: nil)
                defaults.set(try LiveSessionPreferences.saving(mac(), in: Data()), forKey: preferencesKey)
            }
            if owner == primary, arguments.contains("--automatic-sessions-fixture") {
                let savedPins = (try? LiveSessionPreferences.read(defaults.data(forKey: preferencesKey) ?? Data()))?.pinnedSessions ?? []
                if trailer {
                    try await store.write("machines.yaml", content: "studio: studio\nlaptop: laptop\n", blobSha: nil)
                    for profile in ["studio", "laptop"] {
                        try await store.write("profiles/\(profile).yaml", content: "name: \(profile)\nprojects:\n  - phren\n  - ledger\n  - hub\n", blobSha: nil)
                    }
                } else if tour {
                    try await store.write("machines.yaml", content: "Mac mini: mac\nlinuxbox: linuxbox\n", blobSha: nil)
                    for profile in ["mac", "linuxbox"] {
                        try await store.write("profiles/\(profile).yaml", content: "name: \(profile)\nprojects:\n  - phren\n  - mina\n  - atlas\n", blobSha: nil)
                    }
                } else {
                try await store.write("phone/FINDINGS.md", content: "# Findings\n\n- [decision] Keep phone sessions connected to project memory\n", blobSha: nil)
                // The store knows this computer carries the project, and where.
                // The schedules fixture registered Desk above; keep it, or its
                // schedules read "unknown computer" when both fixtures run.
                let desk = arguments.contains("--schedules-fixture") ? "Desk: desk\n" : ""
                try await store.write("machines.yaml", content: "Test Mac: mac\n" + desk, blobSha: nil)
                try await store.write("profiles/mac.yaml", content: "name: mac\nprojects:\n  - phone\n", blobSha: nil)
                try await store.write("phone/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/phone\n", blobSha: nil)
                }
                defaults.set(try LiveSessionPreferences.saving(mac(), in: Data()), forKey: preferencesKey)
                if arguments.contains("--all-sessions-fixture") {
                    let remote = try LiveHost(id: hostIDs[1], name: trailer ? "laptop" : tour ? "linuxbox" : "Test Linux",
                                             address: trailer ? "laptop" : tour ? "linuxbox" : "remote.fixture.invalid", username: tour ? "sam" : "fixture",
                                             hookComputerID: hookIDs[1],
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
            // A fresh tokenless client refuses before making any request. The
            // video's store answers every poll with "nothing changed", so the
            // status bar reads live and freshly updated the way a synced
            // store does.
            let synced = trailer || (memory && owner == primary)
            let engine = SyncEngine(client: synced ? TrailerGitHubStub() : GitHubClient(), store: store, stateDirectory: directory)
            if trailer {
                await engine.pull()
                await engine.startLive()
            } else if synced {
                await engine.pull()
            }
            contexts.append(StoreContext(descriptor: StoreDescriptor(owner: owner, name: repo, branch: "main", canPush: true), store: store, engine: engine))
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
        let arguments = ProcessInfo.processInfo.arguments
        let trailer = arguments.contains("--trailer-fixture")
        let tour = arguments.contains("--store-tour-fixture") || trailer
        if arguments.contains("--schedules-fixture") {
            return try LiveHost(id: hostIDs[0], name: "Desk", address: "desk.example", username: "sam",
                                hookComputerID: hookIDs[0],
                                fingerprint: "SHA256:" + String(repeating: "A", count: 43))
        }
        return try LiveHost(id: hostIDs[0], name: trailer ? "studio" : tour ? "Mac mini" : "Test Mac", address: trailer ? "studio" : tour ? "mini" : "fixture.invalid",
                            username: tour ? "sam" : "fixture", hookComputerID: hookIDs[0],
                            fingerprint: "SHA256:" + String(repeating: "A", count: 43))
    }

    static let demoSchedules = """
    version: 1
    schedules:
      - id: 7f3a2c1d
        name: Nightly test sweep
        enabled: true
        computer: Desk
        harness: codex
        model: gpt-5.6-sol
        every: daily
        at: "07:30"
        prompt: |
          Run the full test suite, fix what is red, and leave a summary in tasks.
        createdAt: 2026-09-20T21:00:00Z
        updatedAt: 2026-09-20T21:00:00Z
      - id: 8a4b3c2d
        name: Weekday review
        enabled: true
        computer: Desk
        harness: claude
        every: weekly
        at: "07:30"
        days: [mon, tue, wed, thu, fri]
        prompt: |
          Review the active work and summarize anything that needs attention.
        createdAt: 2026-09-20T21:05:00Z
        updatedAt: 2026-09-20T21:05:00Z
    """

    static let otherSchedules = """
    version: 1
    schedules:
      - id: 9b5c4d3e
        name: One-time launch check
        enabled: true
        computer: Desk
        harness: opencode
        every: once
        once: 2026-09-21T09:00:00
        prompt: |
          Check the launch once and record the result.
        createdAt: 2026-09-20T21:10:00Z
        updatedAt: 2026-09-20T21:10:00Z
    """

    /// The finding Claude saves in the video's conversation, and the node the
    /// memory graph opens: one text, so the viewer sees the same card twice.
    static let trailerFinding = "Idempotency keys must be scoped per merchant: a retried POST /orders with a key reused across merchants returned the other merchant's order."

    /// The product video's store: three projects a small team would keep —
    /// the app itself, a payments service, the web app — with the dated
    /// findings, tasks and skills phren writes for them.
    private static func populateTrailer(_ store: LocalStore) async throws {
        func finding(_ id: String, _ date: String, _ text: String) -> String { "- \(text) <!-- fid:\(id) --> <!-- created: \(date) --> <!-- phren:status \"active\" -->\n" }
        try await store.write("phren/FINDINGS.md", content: "# phren Findings\n\n## 2026-09-16\n\n"
            + finding("a1b2c3d4", "2026-09-16", "[pitfall] XCUITest: reading UIPasteboard from the runner raises the paste prompt and hangs the run — verify copies through an in-app signal instead.")
            + finding("b2c3d4e5", "2026-09-16", "[decision] Session cards are one flat rounded rectangle under small upper-case section labels; the computer's name sits beside the branch.")
            + "\n## 2026-09-15\n\n"
            + finding("c3d4e5f6", "2026-09-15", "[pattern] Long chats keep tools compact while scrolling: cache the rendered Markdown per message and load older pages a few at a time.")
            + finding("d4e5f6a7", "2026-09-15", "[bug] Two Live Activities: the island shows the highest relevanceScore, so the approval activity is 1.0 and the working summary 0.5.")
            + finding("e5f6a7b8", "2026-09-15", "[pattern] Every chat card belongs to the phren card family — a chip for the server, a verb for the tool, rows for the input, never raw JSON.")
            + "\n## 2026-09-12\n\n"
            + finding("f6a7b8c9", "2026-09-12", "[pitfall] osascript from a launchd agent hangs forever: a background agent can't be prompted for Automation. Use the AX API from a pinned helper.")
            + finding("a7b8c9d0", "2026-09-12", "[pattern] The overview reveals every computer together after the first response, with an eight-second ceiling for unreachable ones.")
            + "\n## 2026-09-09\n\n"
            + finding("b1c2d3e4", "2026-09-09", "[decision] Dictation types straight into the message as you speak; Send after dictation is a setting, not the default.")
            + finding("c2d3e4f5", "2026-09-09", "[pattern] Reads, greps and read-only shell commands fold into one run once three are in a row; a call that changed a file keeps its card.")
            + finding("d3e4f5a6", "2026-09-09", "[pattern] Controls stay at least 44 points; reduce padding and duplicate rows before text size."), blobSha: nil)
        try await store.write("phren/tasks.md", content: """
        # phren tasks

        ## Active

        - [ ] Fix the queue strip: one row per queued message, remove and send-now on each [high] <!-- bid:10a1b2c3 -->
          Context: The strip sits on the composer; the transcript never moves when it changes.
        - [ ] Ship the onboarding flow: first-run screens, GitHub sign-in, add a computer [high] <!-- bid:11a1b2c3 -->

        ## Queue

        - [ ] Widget: show the session that needs you most on the Lock Screen <!-- bid:20b2c3d4 -->
        - [ ] Terminal: pinch to change the text size and the remote grid together <!-- bid:30c3d4e5 -->

        ## Done

        - [x] Inline approvals in chat, with Open terminal beside Deny and Approve <!-- bid:50e5f6a7 -->
        - [x] Account usage rings on the Sessions toolbar <!-- bid:60f6a7b8 -->
        """, blobSha: nil)
        try await store.write("phren/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/phren\n", blobSha: nil)
        try await store.write("phren/skills/design.md", content: SkillFile.template(name: "design", description: "Design pass on a named screen", instructions: "Fix hierarchy, spacing and density against phren's own conventions, then verify on the simulator."), blobSha: nil)
        try await store.write("ledger/FINDINGS.md", content: "# ledger Findings\n\n## 2026-09-16\n\n"
            + finding("1a2b3c4d", "2026-09-16", "[pitfall] " + trailerFinding)
            + finding("2b3c4d5e", "2026-09-16", "[decision] Invoices are generated from the ledger, never from order totals; the two disagreed by tax adjustments until the ledger became the source of truth.")
            + "\n## 2026-09-14\n\n"
            + finding("3c4d5e6f", "2026-09-14", "[bug] A cart total drifting by one cent traced to TaxCalculator rounding per line instead of per order; totals are now rounded once at the end.")
            + finding("4d5e6f7a", "2026-09-14", "[pattern] OrderRepository loaded line items with one query per row; batching them through LineItemLoader cut p95 checkout latency from 840ms to 210ms.")
            + finding("5e6f7a8b", "2026-09-14", "[decision] Webhook signatures are verified with a constant-time compare; the previous string equality leaked timing and was flagged in the pentest.")
            + "\n## 2026-09-11\n\n"
            + finding("6f7a8b9c", "2026-09-11", "[decision] The ledger is append-only; corrections are new entries with a reversal reference, which keeps the monthly close reproducible.")
            + finding("7a8b9c0d", "2026-09-11", "[pitfall] The orders table needs the (merchant_id, created_at) index or the merchant dashboard query does a full scan once a merchant passes ~50k orders.")
            + finding("8b9c0d1e", "2026-09-11", "[pattern] Currency amounts are stored as integer minor units; the one float column left in refunds was the source of the July reconciliation gap.")
            + "\n## 2026-09-08\n\n"
            + finding("9c0d1e2f", "2026-09-08", "[pattern] Cursor pagination replaced offset pagination on GET /orders because offset pages shifted while new orders arrived during export.")
            + finding("0d1e2f3a", "2026-09-08", "[decision] Contract tests against the billing sandbox run nightly, not on every push: the sandbox rate limit made the PR suite flaky."), blobSha: nil)
        try await store.write("ledger/tasks.md", content: """
        # ledger tasks

        ## Active

        - [ ] Ship the onboarding flow: merchant sign-up, first order, webhook secret [high] <!-- bid:70a7b8c9 -->
          Context: Idempotency keys are merchant-scoped now; the sign-up form still needs the retry banner.
        - [ ] Backfill merchant_id onto legacy idempotency rows [high] <!-- bid:71a7b8c9 -->

        ## Queue

        - [ ] Retire the offset pagination shim after the export clients migrate <!-- bid:80b8c9d0 -->
        - [ ] Rotate per-merchant webhook secrets on a schedule <!-- bid:81b8c9d0 -->

        ## Done

        - [x] Batch line items through LineItemLoader <!-- bid:90c9d0e1 -->
        """, blobSha: nil)
        try await store.write("ledger/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/ledger\n", blobSha: nil)
        try await store.write("hub/FINDINGS.md", content: "# hub Findings\n\n## 2026-09-15\n\n"
            + finding("f1e2d3c4", "2026-09-15", "[bug] The checkout form re-rendered on every keystroke because the cart context held the whole order; splitting CartContext into totals and items fixed it.")
            + finding("e2d3c4b5", "2026-09-15", "[pattern] SessionStore keeps the draft cart in IndexedDB so a refresh mid-checkout restores the cart instead of emptying it.")
            + "\n## 2026-09-13\n\n"
            + finding("d3c4b5a6", "2026-09-13", "[decision] Route-level code splitting took the initial bundle from 1.4MB to 410KB; the analytics SDK loads after first paint.")
            + finding("c4b5a6f7", "2026-09-13", "[pitfall] A blank page on iOS 17 was a top-level await in the analytics bundle; Safari 17.0 does not support it in classic scripts.")
            + finding("b5a6f7e8", "2026-09-13", "[decision] The session cookie is SameSite=Lax; the OAuth callback needed an explicit redirect page for Safari.")
            + "\n## 2026-09-10\n\n"
            + finding("a6f7e8d9", "2026-09-10", "[pattern] Playwright smoke tests run against the preview deploy on every PR; they cover sign-in, add to cart and checkout only.")
            + finding("f7e8d9c0", "2026-09-10", "[pattern] Access tokens live for 10 minutes and refresh tokens for 30 days; refresh rotation revokes the old token on first use to detect replay.")
            + finding("e8d9c0b1", "2026-09-10", "[pitfall] The dev server needs the proxy entry for /api or local sign-in loops forever on the callback."), blobSha: nil)
        try await store.write("hub/tasks.md", content: """
        # hub tasks

        ## Active

        - [ ] Review release notes for 2.4: cart drafts, code splitting, the Safari redirect [medium] <!-- bid:a0a7b8c9 -->

        ## Queue

        - [ ] Move cart totals to a server-computed field <!-- bid:b0b8c9d0 -->
        - [ ] Add a visual regression check for the order summary <!-- bid:b1b8c9d0 -->

        ## Done

        - [x] Drop the legacy date picker <!-- bid:c0c9d0e1 -->
        """, blobSha: nil)
        try await store.write("hub/phren.project.yaml", content: "ownership: repo-managed\nsourcePath: /work/hub\n", blobSha: nil)
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
            + finding("d4e5f6a7", "[bug] Two Live Activities: the island shows the highest relevanceScore, so the approval activity is 1.0 and the working summary 0.5.")
            + finding("e5f6a7b8", "[pattern] Every chat card belongs to the phren card family — a chip for the server, a verb for the tool, rows for the input, never raw JSON.")
            + "\n## 2026-09-12\n\n"
            + finding("f6a7b8c9", "[pitfall] osascript from a launchd agent hangs forever: a background agent can't be prompted for Automation. Use the AX API from a pinned helper.")
            + finding("a7b8c9d0", "[pattern] The overview reveals every computer together after the first response, with an eight-second ceiling for unreachable ones.")
            + "\n## 2026-09-09\n\n"
            + finding("b1c2d3e4", "[decision] Dictation types straight into the message as you speak; Send after dictation is a setting, not the default.")
            + finding("c2d3e4f5", "[pattern] Reads, greps and read-only shell commands fold into one run once three are in a row; a call that changed a file keeps its card.")
            + finding("d3e4f5a6", "[bug] The terminal owns its pan gesture: a finger swipe scrolls, a mouse-aware TUI gets wheel events, never cursor keys.")
            + finding("e4f5a6b7", "[pattern] Controls stay at least 44 points; reduce padding and duplicate rows before text size."), blobSha: nil)
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
            + finding("e1f2a3b4", "[pattern] Stat tiles, entry rows and the goals header switch to vertical stacks at accessibility sizes.")
            + finding("f5a6b7c8", "[bug] A force-quit app keeps a stale feed alarm; the silent push re-arms it on the next launch.")
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

    /// The Memory tab's store: three projects, 40 findings over six topics
    /// with mentions that link the projects, two notes, nine tasks across
    /// the sections, and one project with nothing saved yet.
    private static func populateMemory(_ store: LocalStore) async throws {
        func finding(_ id: String, _ date: String, _ text: String) -> String {
            "- \(text) <!-- fid:\(id) --> <!-- created: \(date) --> <!-- phren:status \"active\" -->\n"
        }
        try await store.write("phren/FINDINGS.md", content: "# phren Findings\n\n## 2026-09-19\n\n"
            + finding("a0000001", "2026-09-19", "[decision] The Search tab becomes Memory: the graph, the findings and the tasks on one page, with search folded in.")
            + finding("a0000002", "2026-09-19", "[pattern] Panel heights snap to collapsed, half and full; a drag picks the nearest by its projected end.")
            + finding("a0000003", "2026-09-19", "[pitfall] A container accessibility identifier hides its children's ids; put it on a zero-size marker instead.")
            + "\n## 2026-09-18\n\n"
            + finding("a0000004", "2026-09-18", "[bug] Five or more string terms chained in an accessibility label make the type checker give up; join an array instead.")
            + finding("a0000005", "2026-09-18", "[pattern] Rows are one flat rectangle on the panel surface, four points apart, with no dividers.")
            + finding("a0000006", "2026-09-18", "[workaround] scrollTo on a lazy list that just appeared needs one run loop turn before it finds the row.")
            + finding("a0000007", "2026-09-18", "[context] The ledger service and the hub app share the store; their findings link through project mentions.")
            + "\n## 2026-09-16\n\n"
            + finding("a0000008", "2026-09-16", "[pitfall] XCUITest: reading UIPasteboard from the runner raises the paste prompt and hangs the run; verify copies through an in-app signal instead.")
            + finding("a0000009", "2026-09-16", "[decision] Session cards are one flat rounded rectangle under small upper-case section labels; the computer's name sits beside the branch.")
            + finding("a0000010", "2026-09-16", "[pattern] Long chats keep tools compact while scrolling: cache the rendered Markdown per message and load older pages a few at a time.")
            + "\n## 2026-09-15\n\n"
            + finding("a0000011", "2026-09-15", "[bug] Two Live Activities: the island shows the highest relevanceScore, so the approval activity is 1.0 and the working summary 0.5.")
            + finding("a0000012", "2026-09-15", "[pattern] Every chat card belongs to the phren card family: a chip for the server, a verb for the tool, rows for the input, never raw JSON.")
            + finding("a0000013", "2026-09-15", "[workaround] The graph's own back button replaces the system one so a canvas drag never pops the screen.")
            + "\n## 2026-09-12\n\n"
            + finding("a0000014", "2026-09-12", "[pitfall] osascript from a launchd agent hangs forever: a background agent cannot be prompted for Automation. Use the AX API from a pinned helper.")
            + finding("a0000015", "2026-09-12", "[pattern] The overview reveals every computer together after the first response, with an eight-second ceiling for unreachable ones.")
            + "\n## 2026-09-09\n\n"
            + finding("a0000016", "2026-09-09", "[decision] Dictation types straight into the message as you speak; Send after dictation is a setting, not the default.")
            + finding("a0000017", "2026-09-09", "[context] Reduce Motion removes the panel's height animation and the sheet's finger-following offset.")
            + finding("a0000018", "2026-09-09", "[pattern] Controls stay at least 44 points; reduce padding and duplicate rows before text size.")
            + "\n## 2026-09-15\n\n"
            + finding("f1e2d3c4", "2026-09-15", "[bug] The checkout form re-rendered on every keystroke because the cart context held the whole order; splitting CartContext into totals and items fixed it.")
            + finding("e2d3c4b5", "2026-09-15", "[pattern] SessionStore keeps the draft cart in IndexedDB so a refresh mid-checkout restores the cart instead of emptying it.")
            + "\n## 2026-09-13\n\n"
            + finding("d3c4b5a6", "2026-09-13", "[decision] Route-level code splitting took the initial bundle from 1.4MB to 410KB; the analytics SDK loads after first paint.")
            + finding("c4b5a6f7", "2026-09-13", "[pitfall] A blank page on iOS 17 was a top-level await in the analytics bundle; Safari 17.0 does not support it in classic scripts.")
            + finding("b5a6f7e8", "2026-09-13", "[context] Sign-in talks to the ledger token service; the phren store keeps the shared session rules.")
            + "\n## 2026-09-10\n\n"
            + finding("a6f7e8d9", "2026-09-10", "[pattern] Playwright smoke tests run against the preview deploy on every PR; they cover sign-in, add to cart and checkout only.")
            + finding("e8d9c0b1", "2026-09-10", "[workaround] The dev server needs the proxy entry for /api or local sign-in loops forever on the callback.")
            + finding("f7e8d9c0", "2026-09-10", "[pattern] Access tokens live for 10 minutes and refresh tokens for 30 days; refresh rotation revokes the old token on first use to detect replay."), blobSha: nil)
        try await store.write("phren/tasks.md", content: """
        # phren tasks

        ## Active

        - [ ] Fix the queue strip: one row per queued message, remove and send-now on each [high] <!-- bid:10a1b2c3 created:2026-09-17T09:00:00.000Z -->
          Context: The strip sits on the composer; the transcript never moves when it changes.
        - [ ] Ship the Memory tab: search field, scope chips, the panel and its rows [high] <!-- bid:11a1b2c3 created:2026-09-19T08:30:00.000Z -->

        ## Queue

        - [ ] Widget: show the session that needs you most on the Lock Screen <!-- bid:20b2c3d4 created:2026-09-12T10:00:00.000Z -->
        - [ ] Terminal: pinch to change the text size and the remote grid together <!-- bid:30c3d4e5 -->
        - [ ] Move cart totals to a server-computed field <!-- bid:b0b8c9d0 created:2026-09-14T12:00:00.000Z -->

        ## Done

        - [x] Inline approvals in chat, with Open terminal beside Deny and Approve <!-- bid:50e5f6a7 created:2026-09-05T10:00:00.000Z -->
        """, blobSha: nil)
        try await store.write("phren/notes/2026-09-18.md", content: """
        ## 09:12 <!-- nid:aa11bb22 -->

        Ship the Memory tab before the schedule editor lands; the graph is the page people open.

        ## 14:40 <!-- nid:cc33dd44 -->

        Retest the graph with forty findings on the phone; the labels crowd at the default zoom.
        """, blobSha: nil)
        try await store.write("ledger/FINDINGS.md", content: "# ledger Findings\n\n## 2026-09-16\n\n"
            + finding("1a2b3c4d", "2026-09-16", "[pitfall] Idempotency keys must be scoped per merchant: a retried POST /orders with a key reused across merchants returned the other merchant's order.")
            + finding("2b3c4d5e", "2026-09-16", "[decision] Invoices are generated from the ledger, never from order totals; the two disagreed by tax adjustments until the ledger became the source of truth.")
            + "\n## 2026-09-14\n\n"
            + finding("3c4d5e6f", "2026-09-14", "[bug] A cart total drifting by one cent traced to TaxCalculator rounding per line instead of per order; totals are now rounded once at the end.")
            + finding("4d5e6f7a", "2026-09-14", "[pattern] OrderRepository loaded line items with one query per row; batching them through LineItemLoader cut p95 checkout latency from 840ms to 210ms.")
            + finding("5e6f7a8b", "2026-09-14", "[decision] Webhook signatures are verified with a constant-time compare; the previous string equality leaked timing and was flagged in the pentest.")
            + finding("6a7b8c9d", "2026-09-14", "[workaround] The billing sandbox drops the first request after an idle hour; a warm-up ping before the nightly run keeps the suite green.")
            + "\n## 2026-09-11\n\n"
            + finding("6f7a8b9c", "2026-09-11", "[decision] The ledger is append-only; corrections are new entries with a reversal reference, which keeps the monthly close reproducible.")
            + finding("7a8b9c0d", "2026-09-11", "[pitfall] The orders table needs the (merchant_id, created_at) index or the merchant dashboard query does a full scan once a merchant passes 50k orders.")
            + finding("8b9c0d1e", "2026-09-11", "[pattern] Currency amounts are stored as integer minor units; the one float column left in refunds was the source of the July reconciliation gap.")
            + finding("8c9d0e1f", "2026-09-11", "[context] The hub checkout calls ledger for totals; a ledger outage shows in hub as an empty cart summary.")
            + "\n## 2026-09-08\n\n"
            + finding("9c0d1e2f", "2026-09-08", "[pattern] Cursor pagination replaced offset pagination on GET /orders because offset pages shifted while new orders arrived during export.")
            + finding("0d1e2f3a", "2026-09-08", "[decision] Contract tests against the billing sandbox run nightly, not on every push: the sandbox rate limit made the PR suite flaky.")
            + finding("0e2f3a4b", "2026-09-08", "[bug] Refund webhooks arrived twice under retry; the handler now records the event id before acting.")
            + finding("1f3a4b5c", "2026-09-08", "[workaround] The export job streams CSV rows instead of building the file in memory; the 2GB export no longer restarts the worker."), blobSha: nil)
        try await store.write("ledger/tasks.md", content: """
        # ledger tasks

        ## Active

        - [ ] Backfill merchant_id onto legacy idempotency rows [high] <!-- bid:70a7b8c9 created:2026-09-16T12:00:00.000Z -->
          Context: Idempotency keys are merchant-scoped now; the sign-up form still needs the retry banner.

        ## Queue

        - [ ] Retire the offset pagination shim after the export clients migrate <!-- bid:80b8c9d0 created:2026-09-10T12:00:00.000Z -->

        ## Done

        - [x] Batch line items through LineItemLoader <!-- bid:90c9d0e1 created:2026-09-13T12:00:00.000Z -->
        """, blobSha: nil)
        try await store.write("hub/FINDINGS.md", content: "# hub Findings\n", blobSha: nil)
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

/// GitHub for the product video's store: every poll answers "nothing
/// changed", so the engine stamps a fresh sync time and never fetches.
private struct TrailerGitHubStub: GitHubAPI {
    func headSha(owner: String, repo: String, branch: String) async throws -> String? { nil }
    func tree(owner: String, repo: String, sha: String) async throws -> GitTree { throw PhrenKitError.validation("The video's store never fetches.") }
    func blob(owner: String, repo: String, sha: String) async throws -> Data { throw PhrenKitError.validation("The video's store never fetches.") }
    func putFile(owner: String, repo: String, path: String, branch: String, content: Data, message: String, sha: String?) async throws -> ContentsPutResponse {
        throw PhrenKitError.validation("The video's store never pushes.")
    }
    func deleteFile(owner: String, repo: String, path: String, branch: String, message: String, sha: String) async throws {
        throw PhrenKitError.validation("The video's store never pushes.")
    }
}
#endif
