import PhrenKit
import PhrenLive
import SwiftUI

@Observable @MainActor
final class LiveHostMonitor {
    var snapshot: LiveWorkspaces?
    var lastUpdated: Date? { didSet { if lastUpdated != oldValue { updateFreshness() } } }
    var message: String?
    var fingerprint: String?
    var refreshing = false
    var polling = false
    /// Answering, but under load or through a slow gateway. Not unreachable.
    var slowToAnswer: Bool { snapshot?.phren?.slowToAnswer == true }
    /// True until this contact period's first request resolves. While the
    /// phone is reaching a computer its cached rows stay in the live groups
    /// and are never labelled stale; only an answer that ages out, or an
    /// outright failure, makes it not live.
    private(set) var awaitingAnswer = true
    /// The last answer is younger than `freshSeconds`. Set when an answer
    /// lands and once more when it ages out, from a one-shot timer, so cards
    /// and the overview observe freshness without a per-second clock.
    private(set) var fresh = false
    /// Fresh, or still making first contact since the app became active.
    var live: Bool { fresh || (awaitingAnswer && message == nil) }
    /// A computer that answered and whose answer has aged out.
    var stale: Bool { !live && lastUpdated != nil }
    @ObservationIgnored private var expiry: Task<Void, Never>?
    private var generation = UUID()
    @ObservationIgnored private var refreshRequested = false
    @ObservationIgnored private let fetchSnapshot: (LiveHost, Date?) async throws -> LiveWorkspaces
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored var onSnapshotChanged: (() -> Void)?
    @ObservationIgnored private var publishing: Task<Void, Never>?
    @ObservationIgnored private let approvals = OverviewApprovalMonitor()
    @ObservationIgnored private var approvalRefresh: Task<Void, Never>?
    /// Opens the Hook's pushed overview; nil where there is none to open.
    @ObservationIgnored private let openStream: ((LiveHost) -> AsyncThrowingStream<LiveOverviewFrame, Error>)?
    /// The overview is arriving over the Hook's stream rather than polls.
    private(set) var streaming = false
    @ObservationIgnored private var streamHost: LiveHost?
    @ObservationIgnored private var streamFailures = 0
    @ObservationIgnored private var streamRetryAt = Date.distantPast
    @ObservationIgnored private var sleeper: Task<Void, Never>?
    @ObservationIgnored private var oneShot: Task<Void, Never>?

    private func updateFreshness() {
        let now = Date.now
        let current = isFresh(at: now)
        if fresh != current { fresh = current }
        expiry?.cancel(); expiry = nil
        guard current, let lastUpdated else { return }
        let remaining = lastUpdated.addingTimeInterval(Self.freshSeconds).timeIntervalSince(now)
        expiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, remaining)) + .milliseconds(20)) } catch { return }
            guard let self else { return }
            self.updateFreshness()
            self.onSnapshotChanged?()
        }
    }

    /// Fetch again now rather than at the end of the poll interval — after a
    /// close, a launch, anything the person just did to the computer.
    func refreshNow() {
        refreshRequested = true
        sleeper?.cancel()
        // The stream pushes changes on its own within seconds; a request for
        // now still reads once, beside it.
        if streaming, let host = streamHost {
            oneShot?.cancel()
            let run = generation
            oneShot = Task { [weak self] in
                guard let value = try? await self?.fetchSnapshot(host, self?.lastUpdated) else { return }
                guard let self, !Task.isCancelled, self.generation == run else { return }
                self.accept(value, host: host)
                self.onSnapshotChanged?()
            }
        }
    }

    /// The app came back to the foreground: reach this computer again now and
    /// keep its cached rows shown as refreshing, not stale, until the answer
    /// lands or the request fails outright.
    func reconnecting() {
        awaitingAnswer = true
        refreshRequested = true
        onSnapshotChanged?()
    }

    /// Herdr confirmed a close: drop the tab (or workspace) from the snapshot
    /// at once, then fetch so the truth replaces the guess.
    func closed(workspace: String, tab: String?) {
        snapshot = snapshot?.closing(workspace: workspace, tab: tab)
        onSnapshotChanged?()
        refreshNow()
    }

    init(pollInterval: Duration = .seconds(10),
         fetch: @escaping (LiveHost, Date?) async throws -> LiveWorkspaces = { try await LiveHostMonitor.fetch($0, previousUpdate: $1) },
         stream: ((LiveHost) -> AsyncThrowingStream<LiveOverviewFrame, Error>)? = LiveHostMonitor.defaultStream) {
        self.pollInterval = pollInterval; self.fetchSnapshot = fetch; self.openStream = stream
    }

    /// Waits up to `duration`; `refreshNow()` ends the wait early.
    private func pause(_ duration: Duration) async {
        let sleeper = Task { _ = try? await Task.sleep(for: duration) }
        self.sleeper = sleeper
        await withTaskCancellationHandler { await sleeper.value } onCancel: { sleeper.cancel() }
        if self.sleeper == sleeper { self.sleeper = nil }
    }

    @ObservationIgnored private var approvalsCheckedAt = Date.distantPast

    /// Reads held permission requests again: on every change, and every ten
    /// seconds while a tab reports one, since a new request can replace an
    /// old one without changing the overview.
    private func refreshApprovals(_ value: LiveWorkspaces, host: LiveHost, changed: Bool) {
        let sessions = value.sessions(on: host)
        guard changed || (sessions.contains { $0.tab.approvalPending == true } && Date().timeIntervalSince(approvalsCheckedAt) >= 10)
        else { return }
        approvalsCheckedAt = Date()
        approvalRefresh?.cancel()
        approvalRefresh = Task {
            await ApprovalActivityController.shared.reconcile(host: host, sessions: sessions)
            await approvals.refresh(sessions)
        }
    }

    /// A successful overview, from a poll or the stream.
    private func accept(_ value: LiveWorkspaces, host: LiveHost) {
        let changed = snapshot != value
        refreshApprovals(value, host: host, changed: changed)
        if changed {
            snapshot = value
            // UI publication must not wait for Spotlight/WidgetKit disk
            // writes or ActivityKit. Coalesce obsolete side effects.
            publishing?.cancel()
            publishing = Task {
                await Task.yield()
                guard !Task.isCancelled else { return }
                let sessions = value.sessions(on: host)
                SpotlightIndex.shared.refreshSessions(sessions, on: host)
                await WidgetBridge.publishSessions(sessions, on: host)
            }
        }
        lastUpdated = Date()
        if message != nil { message = nil }
        if fingerprint != nil { fingerprint = nil }
    }

    /// Whether this answer came from a Hook that pushes its overview.
    private func pushes(_ value: LiveWorkspaces?) -> Bool {
        #if DEBUG && targetEnvironment(simulator)
        if Self.fixtureStream { return true }
        #endif
        return value?.capabilities?.overviewStream == true
    }

    /// Holds the Hook's overview stream open, applying each frame, until it
    /// ends. Returns how long it stayed open.
    private func follow(host: LiveHost, run: UUID) async -> TimeInterval {
        guard let openStream else { return 0 }
        let opened = Date()
        PerformanceCounters.bump("stream.overview-open")
        streaming = true; streamHost = host
        defer { if generation == run { streaming = false; streamHost = nil } }
        do {
            for try await frame in openStream(host) {
                guard generation == run, !Task.isCancelled else { break }
                PerformanceCounters.bump("stream.overview-frames")
                switch frame {
                case .overview(let value):
                    accept(value, host: host)
                case .heartbeat(let info):
                    lastUpdated = Date()
                    if message != nil { message = nil }
                    if let info, let current = snapshot, current.phren != info { snapshot = current.updating(info: info) }
                    if let current = snapshot { refreshApprovals(current, host: host, changed: false) }
                }
                onSnapshotChanged?()
            }
        } catch {
            // A dropped stream is not an unreachable computer: the next poll
            // says whether it still answers.
        }
        return Date().timeIntervalSince(opened)
    }

    func run(host: LiveHost, onFirstRefresh: (@MainActor () -> Void)? = nil) async {
        let run = UUID()
        generation = run
        polling = true
        awaitingAnswer = true
        var first = true
        defer { if generation == run { polling = false; refreshing = false; approvalRefresh?.cancel() } }
        while !Task.isCancelled {
            PerformanceCounters.bump("poll.overview")
            refreshing = true
            let fetchStarted = CFAbsoluteTimeGetCurrent()
            do {
                let value = try await fetchSnapshot(host, lastUpdated)
                try Task.checkCancellation()
                guard generation == run else { return }
                accept(value, host: host)
            } catch {
                guard !Task.isCancelled, generation == run else { return }
                message = (error as? LiveConnectionError)?.localizedDescription
                    ?? (error as? PhrenKitError)?.localizedDescription
                    ?? "Couldn't reach the computer. Check the address, Tailscale, SSH, and Phren Hook."
                if case LiveConnectionError.untrustedHost(let key) = error { fingerprint = key }
                #if DEBUG && targetEnvironment(simulator)
                if AppRuntime.isUITesting && ProcessInfo.processInfo.arguments.contains("--all-sessions-offline") {
                    lastUpdated = .now.addingTimeInterval(-91)
                }
                #endif
            }
            refreshing = false
            let resolvedFirst = first
            awaitingAnswer = false
            if first { first = false; onFirstRefresh?() }
            onSnapshotChanged?()
            #if DEBUG
            if resolvedFirst, ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
                // First answer for this host in this run: the number the phone
                // feels before the overview turns live.
                let elapsed = (CFAbsoluteTimeGetCurrent() - fetchStarted) * 1_000
                print("[PhrenPerformance] host \(host.name) first read: \(String(format: "%.1f", elapsed)) ms")
            }
            #endif
            if fingerprint != nil { return }
            // A Hook that pushes its overview keeps one socket open and this
            // loop waits on it; polling resumes only while the stream is down.
            if message == nil, openStream != nil, pushes(snapshot), Date() >= streamRetryAt {
                refreshRequested = false
                let lasted = await follow(host: host, run: run)
                guard !Task.isCancelled, generation == run else { return }
                // A stream that failed at once backs off before the next try,
                // so a Hook that cannot hold one is simply polled.
                streamFailures = lasted < 30 ? streamFailures + 1 : 0
                streamRetryAt = streamFailures == 0 ? .now
                    : .now.addingTimeInterval(min(300, 30 * Double(streamFailures)))
                if refreshRequested || streamFailures == 0 { continue }
            }
            refreshRequested = false
            await pause(pollInterval)
            if Task.isCancelled { return }
        }
    }

    /// The Hook's `/v1/overview` stream for a real computer. UI tests poll
    /// their fixtures unless `--overview-stream-fixture` asks for a stream.
    static let defaultStream: ((LiveHost) -> AsyncThrowingStream<LiveOverviewFrame, Error>)? = {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting { return fixtureStream ? { fixtureOverviewStream($0) } : nil }
        #endif
        return { host in
            do { return PhrenConnection.overviewUpdates(host: host, privateKey: try DeviceSSHKey.load(host.id)) }
            catch { return AsyncThrowingStream { $0.finish(throwing: error) } }
        }
    }()

    #if DEBUG && targetEnvironment(simulator)
    static let fixtureStream = AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--overview-stream-fixture")

    /// What a Hook's stream does, over the fixtures: read the overview every
    /// five seconds, send it when it changed, heartbeat otherwise.
    private static func fixtureOverviewStream(_ host: LiveHost) -> AsyncThrowingStream<LiveOverviewFrame, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var last: LiveWorkspaces?, sentAt = Date.distantPast, previous: Date?
                do {
                    while !Task.isCancelled {
                        let value = try await fetch(host, previousUpdate: previous)
                        previous = .now
                        if value != last { continuation.yield(.overview(value)); last = value; sentAt = .now }
                        else if Date().timeIntervalSince(sentAt) >= 20 { continuation.yield(.heartbeat(nil)); sentAt = .now }
                        try await Task.sleep(for: .seconds(5))
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
    #endif

    static func fetch(_ host: LiveHost, previousUpdate: Date? = nil) async throws -> LiveWorkspaces {
        #if DEBUG && targetEnvironment(simulator)
        if AppRuntime.isUITesting && ProcessInfo.processInfo.arguments.contains("--project-chooser-fixture") {
            return try ProjectAgentChooserFixture.snapshot(host: host)
        }
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--all-sessions-fixture") {
            if ProcessInfo.processInfo.arguments.contains("--all-sessions-empty") {
                return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[]}"#.utf8))
            }
            let remote = host.id.uuidString.hasSuffix("000002")
            if remote && previousUpdate == nil && ProcessInfo.processInfo.arguments.contains("--all-sessions-delayed") {
                try await Task.sleep(for: .seconds(4))
            }
            if remote && previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--all-sessions-offline") {
                throw LiveConnectionError.disconnected
            }
            if ProcessInfo.processInfo.arguments.contains("--trailer-fixture") {
                // The product video: two computers, all three harnesses, one
                // session working on each and one that needs you.
                let changed = ",\"lastChangedAt\":\"\(UITestFixtures.sessionActivityDate.ISO8601Format())\""
                let closed = await UITestFixtures.closedTabs
                let tabs = (remote
                    ? [#"{"id":"w1:t1","label":"1","title":"Fix the queue strip","agent":"codex","agentStatus":"working","cwd":"/work/phren","branch":"ios/chat","contextUsedPercent":62\#(changed)}"#,
                       #"{"id":"w1:t2","label":"2","title":"Write the changelog","agent":"claude","agentStatus":"idle","cwd":"/work/phren","branch":"ios/chat"}"#]
                    : [#"{"id":"w1:t1","label":"1","title":"Ship the onboarding flow","agent":"claude","agentStatus":"working","cwd":"/work/ledger","branch":"main","contextUsedPercent":37\#(changed)}"#,
                       #"{"id":"w1:t2","label":"2","title":"Review release notes","agent":"copilot","agentStatus":"waiting","approvalPending":true,"cwd":"/work/hub","branch":"main"}"#])
                    .enumerated().filter { !closed.contains("\(host.id):w1:t\($0.offset + 1)") }.map(\.element)
                return try LiveWorkspaces.read(Data("""
                {"kind":"herdr","groups":[{"id":"w1","label":"\(remote ? "phren" : "ledger")","children":[\(tabs.joined(separator: ","))]}]}
                """.utf8))
            }
            let tour = ProcessInfo.processInfo.arguments.contains("--store-tour-fixture")
            let title = tour ? (remote ? "Review the deployment" : "Ship the onboarding flow") : remote ? "Review Linux deployment" : "Build the iPhone overview"
            let finished = previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--all-sessions-change")
            let status = remote ? "waiting" : finished ? "done" : "working"
            let other = tour ? (remote ? "Fix the widget timeline" : "Write the release notes") : remote ? "Inspect logs" : "Check project status"
            let changed = ProcessInfo.processInfo.arguments.contains("--session-relative-time-fixture") || tour
                ? ",\"lastChangedAt\":\"\(UITestFixtures.sessionActivityDate.ISO8601Format())\"" : ""
            let closed = await UITestFixtures.closedTabs
            // The tour names real projects and shows all three harnesses.
            let project = tour ? (remote ? "mina" : "phren") : "phone"
            let agents = tour ? (remote ? ("codex", "claude") : ("claude", "copilot")) : ("codex", "claude")
            let branch = tour ? (remote ? "feature/widgets" : "release/1.0") : "feature/settings"
            let tabs = [
                #"{"id":"w1:t1","label":"1","title":"\#(title)","agent":"\#(agents.0)","agentStatus":"\#(status)","cwd":"/work/\#(project)","branch":"main","contextUsedPercent":\#(remote ? 62 : 37)\#(changed)}"#,
                #"{"id":"w1:t2","label":"2","title":"\#(other)","agent":"\#(agents.1)","agentStatus":"idle","cwd":"/work/\#(project)","branch":"\#(branch)"}"#,
            ].enumerated().filter { !closed.contains("\(host.id):w1:t\($0.offset + 1)") }.map(\.element)
            return try LiveWorkspaces.read(Data("""
            {"kind":"herdr","groups":[{"id":"w1","label":"\(tour ? project : "Shared project")","children":[\(tabs.joined(separator: ","))]}]}
            """.utf8))
        }
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--automatic-sessions-fixture") {
            if ProcessInfo.processInfo.arguments.contains("--session-discovery-offline") { throw LiveConnectionError.disconnected }
            if ProcessInfo.processInfo.arguments.contains("--chat-long-location") {
                // A folder no project maps, with a long name: the chat header's location line.
                return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Continue where the earlier session left off in Codex","agent":"claude","agentStatus":"idle","cwd":"/work/an-unusually-long-project-folder-name-for-the-header"}]}]}"#.utf8))
            }
            if ProcessInfo.processInfo.arguments.contains("--conductor-running-fixture") {
                return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w9","label":"Phone conductor","children":[{"id":"w9:t1","label":"1","title":"Phone conductor","agent":"codex","agentStatus":"idle","cwd":"/work/phone","role":"conductor"}]},{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Polish the phone app","agent":"codex","agentStatus":"working","cwd":"/work/phone/src"}]}]}"#.utf8))
            }
            if ProcessInfo.processInfo.arguments.contains("--conductor-fixture"),
               let launch = AgentChatFixture.launches.last(where: { $0.role == "conductor" }) {
                let model = launch.kind == "claude" ? "opus" : launch.kind == "codex" ? "gpt-5" : "default"
                let conductor = #"{"id":"w9:t1","label":"1","title":"Phone conductor","agent":"\#(launch.kind)","agentStatus":"working","cwd":"\#(launch.cwd)","model":"\#(model)","role":"conductor","runningChildren":2,"childProviders":["codex","claude"]}"#
                return try LiveWorkspaces.read(Data((#"{"kind":"herdr","groups":[{"id":"w9","label":"Phone conductor","children":["# + conductor + #"]},{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Polish the phone app","agent":"codex","agentStatus":"working","cwd":"/work/phone/src"}]}]}"#).utf8))
            }
            if let countFlag = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--sessions-layout-count=") }),
               let count = Int(countFlag.split(separator: "=").last ?? ""), [0, 1, 6].contains(count) {
                let titles = ["Polish the phone app", "Review the changes", "Fix the tests", "Write the release notes", "Check the build", "Update the docs"]
                let tabs = (0..<count).map { index in
                    ["id": "w7:t\(index + 1)", "label": "\(index + 1)", "title": titles[index],
                     "agent": index.isMultiple(of: 2) ? "codex" : "claude", "agentStatus": "working",
                     "cwd": "/work/phone", "branch": "main"]
                }
                let payload: [String: Any] = ["kind": "herdr", "groups": [["id": "w7", "label": "Phone work", "children": tabs]]]
                return try LiveWorkspaces.read(JSONSerialization.data(withJSONObject: payload))
            }
            if ProcessInfo.processInfo.arguments.contains("--session-details-fixture") {
                if previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--session-details-removed") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[]}"#.utf8))
                }
                if ProcessInfo.processInfo.arguments.contains("--starting-session-fixture") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"New session","agent":"codex","agentStatus":"idle","starting":true,"cwd":"/work/phone","agentPaneCount":1,"paneCount":1}]}]}"#.utf8))
                }
                if ProcessInfo.processInfo.arguments.contains("--terminal-uploads-fixture") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","focus":{"workspaceID":"w8","tabID":"w8:t1","paneID":"w8:p1"},"groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Original tab","agent":"codex"}]},{"id":"w8","label":"Other work","children":[{"id":"w8:t1","label":"1","title":"Current terminal tab","agent":"codex"}]}]}"#.utf8))
                }
                if ProcessInfo.processInfo.arguments.contains("--trailer-fixture") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"ledger","children":[{"id":"w7:t9","label":"1","title":"Ship the onboarding flow","agent":"claude","agentStatus":"working","cwd":"/work/ledger","branch":"main","agentPaneCount":2,"paneCount":3}]},{"id":"w8","label":"hub","children":[{"id":"w8:t1","label":"1","title":"Review release notes","agent":"copilot","agentStatus":"waiting","cwd":"/work/hub","branch":"main"}]}]}"#.utf8))
                }
                if ProcessInfo.processInfo.arguments.contains("--store-tour-fixture") {
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"phren","children":[{"id":"w7:t9","label":"1","title":"Ship the onboarding flow","agent":"claude","agentStatus":"working","cwd":"/work/phren","branch":"main","agentPaneCount":2,"paneCount":3}]},{"id":"w8","label":"mina","children":[{"id":"w8:t1","label":"1","title":"Review the deployment","agent":"codex","agentStatus":"waiting","cwd":"/work/mina","branch":"main"}]}]}"#.utf8))
                }
                if ProcessInfo.processInfo.arguments.contains("--changes-feature-branch") {
                    // A finished session on a feature branch, for commit, push and the card's pull request.
                    return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Polish the phone app","agent":"codex","agentStatus":"done","cwd":"/work/phone/src","branch":"changes/pulls","agentPaneCount":2,"paneCount":3}]},{"id":"w8","label":"Other work","children":[{"id":"w8:t1","label":"1","title":"Choose the deployment target","agent":"claude","agentStatus":"waiting","cwd":"/work/other"}]}]}"#.utf8))
                }
                return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"1","title":"Polish the phone app","agent":"codex","agentStatus":"working","cwd":"/work/phone/src","agentPaneCount":2,"paneCount":3}]},{"id":"w8","label":"Other work","children":[{"id":"w8:t1","label":"1","title":"Choose the deployment target","agent":"claude","agentStatus":"waiting","cwd":"/work/other"}]},{"id":"w9","label":"Shell","children":[{"id":"w9:t1","label":"1"}]}]}"#.utf8))
            }
            let extra = ProcessInfo.processInfo.arguments.contains("--multiple-project-sessions")
                ? #",{"id":"w7:t10","label":"Review phone changes","agent":"claude","agentStatus":"waiting","cwd":"/work/phone"}"# : ""
            return try LiveWorkspaces.read(Data((#"{"kind":"herdr","groups":[{"id":"w7","label":"Phone work","children":[{"id":"w7:t9","label":"Build phone app","agent":"codex","agentStatus":"working","cwd":"/work/phone/src","sessionId":"not-a-server"}"# + extra + #"]},{"id":"w8","label":"Other work","children":[{"id":"w8:t1","label":"Unrelated session","cwd":"/work/other"}]}]}"#).utf8))
        }
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--live-sessions-fixture") {
            if previousUpdate != nil && ProcessInfo.processInfo.arguments.contains("--live-sessions-offline") {
                throw LiveConnectionError.disconnected
            }
            return try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w1","label":"Phone project","children":[{"id":"w1:t1","label":"Build graph","agent":"codex","agentStatus":"working","cwd":"/work/demo","agentPaneCount":1}]}]}"#.utf8))
        }
        #endif
        return try await PhrenConnection.fetch(host: host, privateKey: DeviceSSHKey.load(host.id))
    }
}

extension LiveHostMonitor {
    /// How long an answer reads as live: 90 seconds. UI tests may shorten it
    /// with `--live-fresh-seconds=N` so the stale state needs no 90 second wait.
    static let freshSeconds: TimeInterval = {
        #if DEBUG
        if AppModel.isUITesting, let flag = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--live-fresh-seconds=") }),
           let seconds = TimeInterval(flag.dropFirst("--live-fresh-seconds=".count)), seconds > 0 {
            return seconds
        }
        #endif
        return 90
    }()

    func isFresh(at date: Date) -> Bool {
        lastUpdated.map { date.timeIntervalSince($0) < Self.freshSeconds } == true
    }

    /// Fresh, or still making first contact since the app became active.
    /// Cached content keeps its place in the live groups while the phone is
    /// reaching a computer instead of dropping to "Last seen" at once.
    func isLive(at date: Date) -> Bool {
        isFresh(at: date) || (awaitingAnswer && message == nil)
    }

    /// Stale is a computer that answered and whose answer has aged out. A
    /// computer the phone has not heard from yet is connecting, not stale.
    func isStale(at date: Date) -> Bool {
        !isLive(at: date) && lastUpdated != nil
    }

    /// The phone is reaching this computer, or has not heard from it yet.
    /// A fresh computer is live even while a poll is in flight.
    var isConnecting: Bool { !fresh && message == nil && (refreshing || awaitingAnswer) }
}
