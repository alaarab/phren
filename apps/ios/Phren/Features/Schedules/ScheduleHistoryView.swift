import PhrenKit
import PhrenLive
import SwiftUI

struct ScheduleHistoryView: View {
    let storeId: String
    let schedule: Schedule

    @Environment(AppModel.self) private var model
    @AppStorage("sessions.live.preferences.v1") private var preferencesData = Data()
    @State private var runs: [ScheduleRun] = []
    @State private var loading = true
    @State private var error: String?

    private var project: String? {
        model.snapshot(for: storeId).schedules.first { _, schedules in
            schedules.contains { $0.id == schedule.id }
        }?.key
    }
    private var hosts: [LiveHost] { (try? LiveSessionPreferences.read(preferencesData))?.hosts ?? [] }
    private var host: LiveHost? {
        hosts.first { host in
            [host.name, host.address].contains { canonical($0) == canonical(schedule.computer) }
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                PhrenMetadataHeader(title: schedule.name, subtitle: ScheduleWords.describe(schedule)) {
                    HStack(spacing: PhrenTheme.Space.xs) {
                        PhrenChip(text: schedule.computer, icon: "desktopcomputer", role: .project)
                        PhrenChip(text: harnessName, role: .type)
                        if let model = schedule.model, !model.isEmpty { PhrenChip(text: model, role: .type) }
                    }
                }
                .padding(.bottom, PhrenTheme.Space.large)

                if loading {
                    ProgressView().tint(PhrenTheme.accent)
                        .frame(maxWidth: .infinity, minHeight: 120)
                        .accessibilityLabel("Loading schedule history")
                } else if let error {
                    Text(error)
                        .font(PhrenTypography.footnote)
                        .foregroundStyle(PhrenTheme.danger)
                        .padding(PhrenTheme.Space.medium)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(PhrenTheme.danger.opacity(0.15),
                                    in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
                } else if runs.isEmpty {
                    Text("No runs yet")
                        .font(PhrenTypography.subheadline)
                        .foregroundStyle(PhrenTheme.textMuted)
                        .frame(maxWidth: .infinity, minHeight: 140)
                } else {
                    ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
                        historyRow(run, index: index)
                    }
                }
            }
            .padding(.horizontal, PhrenTheme.Space.large)
            .padding(.vertical, PhrenTheme.Space.medium)
        }
        .background(PhrenTheme.bg)
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: project) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private func historyRow(_ run: ScheduleRun, index: Int) -> some View {
        let content = HStack(alignment: .stretch, spacing: PhrenTheme.Space.small) {
            PhrenTimelineRail(color: statusColor(run), top: index > 0, bottom: index < runs.count - 1)
            VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
                HStack(spacing: PhrenTheme.Space.small) {
                    Text(Self.startedFormatter.string(from: run.startedAt))
                        .font(PhrenTypography.subheadline)
                        .foregroundStyle(PhrenTheme.text)
                    Spacer(minLength: PhrenTheme.Space.small)
                    Text(duration(run))
                        .font(PhrenTypography.caption)
                        .foregroundStyle(PhrenTheme.textMuted)
                        .monospacedDigit()
                    if canOpen(run) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(PhrenTheme.textDim)
                    }
                }
                Text(statusText(run))
                    .font(PhrenTypography.caption)
                    .foregroundStyle(run.status == "failed" ? PhrenTheme.danger : PhrenTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, PhrenTheme.Space.small)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .contentShape(Rectangle())

        if canOpen(run) {
            Button { openSession(run) } label: { content }
                .buttonStyle(.plain)
                .accessibilityHint("Open session chat")
                .accessibilityIdentifier("schedule-history-row:\(run.id)")
        } else {
            content.accessibilityElement(children: .combine)
                .accessibilityIdentifier("schedule-history-row:\(run.id)")
        }
    }

    private func load() async {
        guard let project else {
            loading = false
            error = "This schedule's project is no longer available."
            return
        }
        guard let host else {
            loading = false
            error = "\(schedule.computer) is offline."
            return
        }
        loading = true
        error = nil
        defer { loading = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--schedules-fixture") {
                runs = try await AgentChatFixture.scheduleHistory(project: project, id: schedule.id, limit: 50)
                    .sorted { $0.startedAt > $1.startedAt }
                return
            }
            #endif
            runs = try await PhrenConnection.scheduleHistory(
                host: host,
                privateKey: try DeviceSSHKey.load(host.id),
                project: project,
                id: schedule.id,
                limit: 50
            ).sorted { $0.startedAt > $1.startedAt }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func canOpen(_ run: ScheduleRun) -> Bool {
        run.launch.workspaceId != nil && run.launch.tabId != nil && run.launch.paneId != nil && host != nil
    }

    private func openSession(_ run: ScheduleRun) {
        guard let host, let project, let workspace = run.launch.workspaceId, let tab = run.launch.tabId else { return }
        let cwd = model.machineRegistry(storeId: storeId).sourcePaths[project] ?? "/"
        guard let session = try? AgentLaunch.session(
            host: host,
            workspaceID: workspace,
            tabID: tab,
            label: schedule.name,
            agent: ScheduleModelLoader.source(for: schedule.harness),
            agentStatus: run.status == "running" ? "working" : "idle",
            cwd: cwd
        ) else { return }
        AgentLaunch.setPending(session)
    }

    private func statusText(_ run: ScheduleRun) -> String {
        guard let reason = run.reason, !reason.isEmpty else { return run.status }
        return "\(run.status): \(reason)"
    }

    private func statusColor(_ run: ScheduleRun) -> Color {
        switch run.status {
        case "finished": PhrenTheme.stateDone
        case "failed": PhrenTheme.danger
        case "launched", "running": PhrenTheme.stateWorking
        case "skipped": PhrenTheme.stateWaiting
        default: PhrenTheme.textMuted
        }
    }

    private func duration(_ run: ScheduleRun) -> String {
        let seconds = max(0, Int((run.finishedAt ?? .now).timeIntervalSince(run.startedAt)))
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        let remainder = seconds % 60
        if hours > 0 { return String(format: "%dh %02dm", hours, minutes) }
        if minutes > 0 { return String(format: "%dm %02ds", minutes, remainder) }
        return "\(remainder)s"
    }

    private var harnessName: String {
        switch schedule.harness {
        case .claude: "Claude"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        }
    }

    private func canonical(_ value: String) -> String {
        var result = value.lowercased()
        if result.hasSuffix(".local") { result.removeLast(".local".count) }
        return result
    }

    private static let startedFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, HH:mm"
        return formatter
    }()
}
