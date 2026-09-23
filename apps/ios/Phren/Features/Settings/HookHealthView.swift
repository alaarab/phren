import PhrenKit
import PhrenLive
import SwiftUI

/// Whether phren is healthy on each computer: tool versions, store sync, the
/// last scheduled run, peers (a one-way link is called out), approval push and
/// the last canary. One group per computer, read from its Hook's
/// `/v1/health/details`.
struct HookHealthView: View {
    var hostID: UUID? = nil
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var refresh = UUID()
    private var hosts: [LiveHost] {
        ((try? LiveSessionPreferences.read(data))?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }

    var body: some View {
        PhrenScreen {
            #if DEBUG && targetEnvironment(simulator)
            if HookHealthFixture.enabled {
                ForEach(HookHealthFixture.computers, id: \.computer.name) { health in
                    HookHealthGroup(name: health.computer.name, state: .loaded(health), runCanary: nil)
                }
            } else { live }
            #else
            live
            #endif
        }
        .phrenContainerMarker("health-screen", label: "Health")
        .navigationTitle("Health").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Refresh health", systemImage: "arrow.clockwise") { refresh = UUID() }
                .accessibilityIdentifier("health-refresh")
        }
        .refreshable { refresh = UUID() }
    }

    @ViewBuilder private var live: some View {
        if hosts.isEmpty {
            Text("Add a computer in Agents to see its health.").font(PhrenTypography.body).foregroundStyle(PhrenTheme.textMuted)
        }
        ForEach(hosts) { host in HookHealthLoader(host: host, refresh: refresh) }
    }
}

enum HookHealthState {
    case loading
    case loaded(HookHealth)
    case failed(String)
}

/// Loads one computer's health and runs its canary on request.
private struct HookHealthLoader: View {
    let host: LiveHost
    let refresh: UUID
    @State private var state: HookHealthState = .loading
    @State private var canaryRunning = false

    var body: some View {
        HookHealthGroup(name: host.name, state: state, runCanary: canaryRunning ? nil : { Task { await canary() } },
                        canaryRunning: canaryRunning)
            .task(id: refresh) { await load() }
    }

    private func load() async {
        do {
            state = .loaded(try await PhrenConnection.hookHealth(host: host, privateKey: DeviceSSHKey.load(host.id)))
        } catch {
            if !Task.isCancelled { state = .failed(error.localizedDescription) }
        }
    }

    private func canary() async {
        canaryRunning = true
        defer { canaryRunning = false }
        _ = try? await PhrenConnection.runCanary(host: host, privateKey: DeviceSSHKey.load(host.id))
        await load()
    }
}

/// One computer's section. Rows use the shared PhrenRow; anything that needs
/// attention adds a plain line under its row in the warning or danger color.
struct HookHealthGroup: View {
    let name: String
    let state: HookHealthState
    let runCanary: (() -> Void)?
    var canaryRunning = false

    var body: some View {
        PhrenGroup(name, identifier: "health-computer:\(name)") {
            switch state {
            case .loading:
                PhrenRow(icon: "clock", title: "Asking \(name)…", chevron: false)
            case .failed(let message):
                PhrenRow(icon: "exclamationmark.triangle", title: "Unreachable", chevron: false)
                warning(message, color: PhrenTheme.danger, id: "health-error:\(name)")
            case .loaded(let health):
                loaded(health)
            }
        }
    }

    @ViewBuilder private func loaded(_ health: HookHealth) -> some View {
        versions(health.versions)
        ForEach(health.stores) { store in
            PhrenRow(icon: "arrow.triangle.2.circlepath", title: store.name, chevron: false) {
                Text(store.position).font(PhrenTypography.monoCaption)
            }
            if let error = store.error {
                warning("Sync: \(error)", color: store.degraded ? PhrenTheme.danger : PhrenTheme.warning,
                        id: "health-sync-error:\(name):\(store.name)")
            }
        }
        scheduleRow(health.schedules)
        peers(health.peers)
        PhrenRow(icon: "bell.badge", title: "Approval push", chevron: false) {
            Text(health.push.configured ? "Configured" : "Not configured")
        }
        canaryRows(health.canary)
    }

    /// Every tool on one wrapping line: "Herdr 0.9.0", "Copilot not installed".
    private func versions(_ versions: [HookHealth.ToolVersion]) -> some View {
        PhrenFlowLayout(spacing: 6) {
            ForEach(versions) { item in
                Text("\(item.title) \(item.status == "missing" ? item.summary.lowercased() : item.summary)")
                    .font(PhrenTypography.caption)
                    .foregroundStyle(item.status == "ok" ? PhrenTheme.textSecondary : item.status == "missing" ? PhrenTheme.textMuted : PhrenTheme.warning)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(PhrenTheme.surfaceRaised, in: Capsule())
                    .phrenIdentifier("health-version:\(name):\(item.tool)")
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
    }

    @ViewBuilder private func scheduleRow(_ schedules: HookHealth.Schedules) -> some View {
        if let run = schedules.lastRun {
            PhrenRow(icon: "calendar.badge.clock", title: run.name ?? "Scheduled run in \(run.project)", chevron: false) {
                Text("\(run.status) · \(Self.ago(run.startedAt))")
            }
            if run.status == "failed" {
                warning(run.reason ?? "The last scheduled run failed.", color: PhrenTheme.danger, id: "health-schedule-error:\(name)")
            }
        } else {
            PhrenRow(icon: "calendar.badge.clock", title: "Schedules", chevron: false) {
                Text(schedules.running == false ? "Scheduler stopped" : "No runs yet")
            }
        }
    }

    @ViewBuilder private func peers(_ peers: HookHealth.Peers) -> some View {
        if let error = peers.error {
            PhrenRow(icon: "desktopcomputer", title: "Peers", chevron: false)
            warning(error, color: PhrenTheme.danger, id: "health-peers-error:\(name)")
        } else if !peers.configured {
            PhrenRow(icon: "desktopcomputer", title: "Peers", chevron: false) { Text("None enrolled") }
        }
        ForEach(peers.computers) { peer in
            PhrenRow(icon: "desktopcomputer", title: peer.name, chevron: false) {
                Text(!peer.reachable ? "Unreachable" : peer.oneWay ? "One-way" : "\(peer.ms) ms")
                    .foregroundStyle(!peer.reachable ? PhrenTheme.danger : peer.oneWay ? PhrenTheme.warning : PhrenTheme.textMuted)
            }
            .phrenIdentifier("health-peer:\(name):\(peer.name)")
            if !peer.reachable, let error = peer.error {
                warning(error, color: PhrenTheme.danger, id: "health-peer-error:\(name):\(peer.name)")
            } else if peer.oneWay {
                warning("One-way: \(peer.name) does not list \(name) back, so it cannot hand work here. Add \(name) to \(peer.name)'s hooks.yaml.",
                        color: PhrenTheme.warning, id: "health-peer-one-way:\(name):\(peer.name)")
            }
        }
    }

    @ViewBuilder private func canaryRows(_ canary: HookHealth.Canary?) -> some View {
        if let runCanary {
            Button(action: runCanary) {
                PhrenRow(icon: "bird", title: "Canary", chevron: false) {
                    Text(canary.map { "\($0.ok ? "Passed" : "Failed") \(Self.ago($0.startedAt)) · Run now" } ?? "Run now")
                }
            }
            .buttonStyle(.plain)
            .phrenIdentifier("health-canary-run:\(name)")
        } else {
            PhrenRow(icon: "bird", title: "Canary", chevron: false) {
                Text(canaryRunning ? "Running…" : canary.map { "\($0.ok ? "Passed" : "Failed") \(Self.ago($0.startedAt))" } ?? "Not run yet")
            }
        }
        if let canary, !canary.ok {
            ForEach(canary.steps.filter { $0.status == "failed" }) { step in
                warning("\(step.name): \(step.reason ?? "failed")", color: PhrenTheme.danger, id: "health-canary-error:\(name):\(step.name)")
            }
        }
    }

    private func warning(_ text: String, color: Color, id: String) -> some View {
        Text(text).font(PhrenTypography.caption).foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).frame(maxWidth: .infinity, alignment: .leading)
            .phrenIdentifier(id)
    }

    static func ago(_ iso: String) -> String {
        guard let date = ISO8601Dates.parse(iso) else { return iso }
        return SessionRelativeTime.text(since: date, at: Date())
    }
}

#if DEBUG && targetEnvironment(simulator)
/// `--hook-health-fixture`: Desk has a failing store sync and a one-way peer;
/// Linuxbox is healthy.
@MainActor
enum HookHealthFixture {
    static var enabled: Bool { AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--hook-health-fixture") }

    static var computers: [HookHealth] { jsons.compactMap { try? HookHealth.decode(Data($0.utf8)) } }

    static var jsons: [String] {
        let now = Date()
        let iso = { (seconds: TimeInterval) in ISO8601Dates.string(from: now.addingTimeInterval(-seconds)) }
        let desk = """
        {"product":"phren-hook","computer":{"name":"Desk"},"checkedAt":"\(iso(0))",
         "versions":[{"tool":"hook","status":"ok","version":"0.2.14"},{"tool":"herdr","status":"ok","version":"0.9.0"},
          {"tool":"claude","status":"ok","version":"2.1.280"},{"tool":"codex","status":"ok","version":"0.155.0"},
          {"tool":"copilot","status":"missing"},{"tool":"opencode","status":"ok","version":"1.4.2"}],
         "stores":[{"name":"primary","role":"primary","available":true,"branch":"main","upstream":"origin/main","ahead":3,"behind":1,
           "lastPushStatus":"push-failed","consecutiveFailures":4,"error":"rejected: non-fast-forward (fetch first)","degraded":true}],
         "schedules":{"running":true,"lastRun":{"name":"Nightly triage","project":"phren","status":"finished","startedAt":"\(iso(7_200))"}},
         "peers":{"configured":true,"computers":[{"name":"Linuxbox","reachable":true,"ms":412,"version":"0.2.14","listsBack":false}]},
         "push":{"configured":true,"devices":1},
         "canary":{"version":1,"trigger":"daily","computer":"Desk","startedAt":"\(iso(14_400))","finishedAt":"\(iso(14_370))","durationMs":30000,"ok":true,
           "steps":[{"name":"conductor","status":"ok","durationMs":20000}]}}
        """
        let linuxbox = """
        {"product":"phren-hook","computer":{"name":"Linuxbox"},"checkedAt":"\(iso(0))",
         "versions":[{"tool":"hook","status":"ok","version":"0.2.14"},{"tool":"herdr","status":"ok","version":"0.9.0"},
          {"tool":"claude","status":"ok","version":"2.1.280"},{"tool":"codex","status":"missing"},{"tool":"copilot","status":"missing"},{"tool":"opencode","status":"missing"}],
         "stores":[{"name":"primary","role":"primary","available":true,"branch":"main","upstream":"origin/main","ahead":0,"behind":0,"lastPushStatus":"saved-pushed","degraded":false}],
         "schedules":{"running":true,"lastRun":null},"peers":{"configured":false,"computers":[]},"push":{"configured":false},"canary":null}
        """
        return [desk, linuxbox]
    }
}
#endif
