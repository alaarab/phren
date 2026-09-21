import PhrenKit
import PhrenLive
import SwiftUI

struct SchedulesView: View {
    let storeId: String
    let project: String?

    @Environment(AppModel.self) private var model
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var reachableHosts: Set<UUID> = []
    @State private var liveState: [String: ScheduleRuntimeState] = [:]
    @State private var enabledOverrides: [String: Bool] = [:]
    @State private var removed: Set<String> = []
    @State private var adding = false
    @State private var editing: ScheduleEditorSelection?

    private var hosts: [LiveHost] {
        ((try? LiveSessionPreferences.read(hostData))?.hosts ?? []).filter { SessionOverviewMonitor.shared.allows(.schedules, on: $0) }
    }

    private var snapshot: LocalStore.Snapshot { model.snapshot(for: storeId) }

    private var entries: [ScheduleListEntry] {
        let projects = project.map { [$0] } ?? snapshot.schedules.keys.sorted()
        return projects.flatMap { name in
            (snapshot.schedules[name] ?? []).compactMap { schedule in
                let key = Self.key(project: name, id: schedule.id)
                guard !removed.contains(key) else { return nil }
                var value = schedule
                if let enabled = enabledOverrides[key] { value.enabled = enabled }
                return ScheduleListEntry(project: name, schedule: value)
            }
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                if entries.isEmpty {
                    emptyState.padding(.top, PhrenTheme.Space.section)
                } else if project != nil {
                    rows(entries)
                } else {
                    ForEach(groupedEntries, id: \.project) { group in
                        HStack(spacing: PhrenTheme.Space.small) {
                            Text(group.project)
                            PhrenCountBadge(count: group.entries.count)
                            Spacer(minLength: 0)
                        }
                        .plainListSectionLabel()
                        rows(group.entries)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, PhrenTheme.Space.section)
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Schedules")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add schedule")
                    .accessibilityIdentifier("schedule-add")
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ActionErrorBanner() }
        .refreshable { await refresh() }
        .task(id: hosts) { await refreshLiveState() }
        .sheet(isPresented: $adding, onDismiss: { Task { await refresh() } }) {
            ScheduleEditorView(storeId: storeId, project: project, schedule: nil)
                .presentationDetents([.large])
        }
        .sheet(item: $editing, onDismiss: { Task { await refresh() } }) { selection in
            ScheduleEditorView(storeId: storeId, project: selection.project, schedule: selection.schedule)
                .presentationDetents([.large])
        }
    }

    private var groupedEntries: [(project: String, entries: [ScheduleListEntry])] {
        Dictionary(grouping: entries, by: \.project)
            .map { ($0.key, sorted($0.value)) }
            .sorted { $0.project.localizedStandardCompare($1.project) == .orderedAscending }
    }

    @ViewBuilder
    private func rows(_ values: [ScheduleListEntry]) -> some View {
        ForEach(sorted(values)) { entry in
            let key = Self.key(project: entry.project, id: entry.schedule.id)
            ScheduleRow(
                storeId: storeId,
                project: entry.project,
                schedule: entry.schedule,
                state: liveState[key],
                host: connectedHost(for: entry.schedule.computer),
                computerKnown: computerIsKnown(entry.schedule.computer),
                onOpen: { editing = .init(project: entry.project, schedule: entry.schedule) },
                onToggle: { enabled in save(entry, enabled: enabled) },
                onDelete: { remove(entry) },
                onRun: { await run(entry) }
            )
        }
    }

    private var emptyState: some View {
        VStack(spacing: PhrenTheme.Space.small) {
            Image(systemName: "clock.badge.checkmark")
                .font(PhrenTypography.icon(28))
                .foregroundStyle(PhrenTheme.textDim)
            Text("No schedules")
                .font(PhrenTypography.subheadline)
                .foregroundStyle(PhrenTheme.textSecondary)
            Button("New schedule") { adding = true }
                .font(PhrenTypography.subheadline.weight(.semibold))
                .foregroundStyle(PhrenTheme.accentSolid)
                .frame(minHeight: 44)
                .padding(.horizontal, PhrenTheme.Space.large)
                .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
        }
        .frame(maxWidth: .infinity)
    }

    private func sorted(_ values: [ScheduleListEntry]) -> [ScheduleListEntry] {
        values.sorted { left, right in
            let leftKey = sortKey(left), rightKey = sortKey(right)
            if leftKey.category != rightKey.category { return leftKey.category < rightKey.category }
            if leftKey.date != rightKey.date { return leftKey.date < rightKey.date }
            return left.schedule.name.localizedStandardCompare(right.schedule.name) == .orderedAscending
        }
    }

    private func sortKey(_ entry: ScheduleListEntry) -> (category: Int, date: Date) {
        let state = liveState[Self.key(project: entry.project, id: entry.schedule.id)]
        let spentOnce: Bool
        if case .once = entry.schedule.every {
            spentOnce = state?.lastRun != nil && state?.nextRun == nil
        } else {
            spentOnce = false
        }
        if spentOnce { return (2, .distantFuture) }
        if !entry.schedule.enabled { return (1, .distantFuture) }
        return (0, state?.nextRun ?? ScheduleWords.nextRun(entry.schedule, after: .now, calendar: .current) ?? .distantFuture)
    }

    private func connectedHost(for computer: String) -> LiveHost? {
        hosts.first { reachableHosts.contains($0.id) && Self.canonicalHost($0.name) == Self.canonicalHost(computer) }
    }

    private func computerIsKnown(_ computer: String) -> Bool {
        snapshot.machines.machines.keys.contains { Self.canonicalHost($0) == Self.canonicalHost(computer) }
    }

    private func refresh() async {
        if AppModel.isUITesting { await model.refresh() }
        else { await model.pullToRefresh() }
        await refreshLiveState()
    }

    private func refreshLiveState() async {
        var refreshed: [String: ScheduleRuntimeState] = [:]
        var reachable: Set<UUID> = []
        let scheduledComputers = Dictionary(uniqueKeysWithValues: entries.map {
            (Self.key(project: $0.project, id: $0.schedule.id), Self.canonicalHost($0.schedule.computer))
        })
        await withTaskGroup(of: (LiveHost, [ScheduleStatus]?).self) { group in
            for host in hosts {
                group.addTask {
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.schedulesEnabled {
                        return (host, try? await AgentChatFixture.schedules(host: host))
                    }
                    #endif
                    return (host, try? await PhrenConnection.schedules(host: host, privateKey: DeviceSSHKey.load(host.id)))
                }
            }
            for await (host, statuses) in group {
                if statuses != nil { reachable.insert(host.id) }
                for status in statuses ?? [] {
                    let key = Self.key(project: status.project, id: status.id)
                    guard scheduledComputers[key] == Self.canonicalHost(host.name) else { continue }
                    refreshed[key] = ScheduleRuntimeState(status)
                }
            }
        }
        liveState = refreshed
        reachableHosts = reachable
    }

    private func save(_ entry: ScheduleListEntry, enabled: Bool) {
        let key = Self.key(project: entry.project, id: entry.schedule.id)
        enabledOverrides[key] = enabled
        let original = snapshot.schedulesContent[entry.project]
        var schedules = snapshot.schedules[entry.project] ?? []
        guard let index = schedules.firstIndex(where: { $0.id == entry.schedule.id }) else { return }
        schedules[index].enabled = enabled
        schedules[index].updatedAt = .now
        let content = SchedulesFile.render(schedules, preserving: original)
        Task {
            do {
                try await model.enqueue(.saveSchedules(project: entry.project, content: content, expectedContent: original), in: storeId)
                await model.refresh()
            } catch { model.lastActionError = error.localizedDescription }
            enabledOverrides.removeValue(forKey: key)
            removed.remove(key)
        }
    }

    private func remove(_ entry: ScheduleListEntry) {
        let key = Self.key(project: entry.project, id: entry.schedule.id)
        removed.insert(key)
        let original = snapshot.schedulesContent[entry.project]
        let schedules = (snapshot.schedules[entry.project] ?? []).filter { $0.id != entry.schedule.id }
        let content = SchedulesFile.render(schedules, preserving: original)
        Task {
            do {
                try await model.enqueue(.saveSchedules(project: entry.project, content: content, expectedContent: original), in: storeId)
                await model.refresh()
            } catch { model.lastActionError = error.localizedDescription }
            enabledOverrides.removeValue(forKey: key)
            removed.remove(key)
        }
    }

    private func run(_ entry: ScheduleListEntry) async {
        guard let host = connectedHost(for: entry.schedule.computer) else { return }
        let key = Self.key(project: entry.project, id: entry.schedule.id)
        let delay = Task { try? await Task.sleep(for: .milliseconds(800)) }
        do {
            let run: ScheduleRun
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.schedulesEnabled {
                run = try await AgentChatFixture.runSchedule(host: host, project: entry.project, id: entry.schedule.id)
            } else {
                run = try await PhrenConnection.runSchedule(host: host, privateKey: DeviceSSHKey.load(host.id), project: entry.project, id: entry.schedule.id)
            }
            #else
            run = try await PhrenConnection.runSchedule(host: host, privateKey: DeviceSSHKey.load(host.id), project: entry.project, id: entry.schedule.id)
            #endif
            await delay.value
            liveState[key] = ScheduleRuntimeState(run: run, nextRun: liveState[key]?.nextRun, running: true)
            Task {
                try? await Task.sleep(for: .seconds(2))
                await refreshLiveState()
            }
        } catch {
            await delay.value
            model.lastActionError = error.localizedDescription
        }
    }

    static func key(project: String, id: String) -> String { "\(project)\u{1f}\(id)" }

    static func canonicalHost(_ name: String) -> String {
        var result = name.lowercased()
        if result.hasSuffix(".local") { result.removeLast(".local".count) }
        return result
    }
}

struct ScheduleRow: View {
    let storeId: String
    let project: String
    let schedule: Schedule
    let state: ScheduleRuntimeState?
    let host: LiveHost?
    let computerKnown: Bool
    let onOpen: () -> Void
    let onToggle: (Bool) -> Void
    let onDelete: () -> Void
    let onRun: () async -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @GestureState private var dragOffset: CGFloat = 0
    @State private var confirmingDelete = false
    @State private var deleteTask: Task<Void, Never>?
    @State private var launching = false

    private var presentedOffset: CGFloat { min(0, max(-144, offset + dragOffset)) }
    private var isOpen: Bool { presentedOffset < 0 }

    var body: some View {
        ZStack(alignment: .trailing) {
            actionStrip
            Group {
                if confirmingDelete { deleteConfirmation }
                else { card }
            }
            .offset(x: presentedOffset)
            .simultaneousGesture(swipeGesture)
        }
        .clipped()
        .onDisappear { deleteTask?.cancel() }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            ZStack(alignment: .bottomTrailing) {
                Button(action: onOpen) {
                    VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                        HStack(spacing: PhrenTheme.Space.small) {
                            Circle().fill(stateColor).frame(width: 8, height: 8)
                            Text(schedule.name)
                                .font(PhrenTypography.subheadline.weight(.semibold))
                                .foregroundStyle(PhrenTheme.text)
                                .lineLimit(1).truncationMode(.tail).layoutPriority(1)
                            Spacer(minLength: PhrenTheme.Space.xs)
                            Text(nextRunText)
                                .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                        }
                        metadata.padding(.trailing, 44).frame(minHeight: 44, alignment: .leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(accessibilityText)
                .accessibilityValue(state?.running == true ? "running" : "")
                .accessibilityIdentifier("schedule-row:\(schedule.id)")

                Button { launch() } label: {
                    ZStack {
                        Circle().fill(PhrenTheme.surfaceRaised).frame(width: 32, height: 32)
                        if launching { ProgressView().controlSize(.small).tint(PhrenTheme.accent) }
                        else { Image(systemName: "play.fill").font(PhrenTypography.icon(12, weight: .semibold)) }
                    }
                    .foregroundStyle(host == nil ? PhrenTheme.textDim : PhrenTheme.accent)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(host == nil || launching || state?.running == true)
                .accessibilityLabel("Run \(schedule.name) now")
                .accessibilityIdentifier("schedule-run:\(schedule.id)")
            }
            HStack(spacing: PhrenTheme.Space.small) {
                Text(ScheduleWords.describe(schedule))
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle()).onTapGesture(perform: onOpen)
                    .accessibilityHidden(true)
                if let lastRun = state?.lastRun {
                    NavigationLink {
                        ScheduleHistoryView(storeId: storeId, project: project, schedule: schedule)
                    } label: {
                        HStack(spacing: PhrenTheme.Space.xs) {
                            Image(systemName: lastRunIcon)
                                .font(PhrenTypography.icon(10, weight: .semibold)).foregroundStyle(lastRunColor)
                            Text(ScheduleWords.relative(lastRun.finishedAt ?? lastRun.startedAt, now: .now))
                                .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                        }
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("History for \(schedule.name)")
                    .accessibilityIdentifier("schedule-history:\(schedule.id)")
                }
            }
        }
        .padding(PhrenTheme.Space.medium)
        .sessionCard()
    }

    private var metadata: some View {
        ScheduleChipFlow(spacing: PhrenTheme.Space.xs) {
            PhrenChip(text: schedule.computer, icon: "desktopcomputer", role: computerKnown ? .host : .bad)
            PhrenChip(text: harnessName, role: .type)
            if let model = schedule.model, !model.isEmpty {
                PhrenChip(text: model, role: .type, monospaced: true)
            }
        }
    }

    private var actionStrip: some View {
        HStack(spacing: 0) {
            Button {
                closeSwipe()
                onToggle(!schedule.enabled)
            } label: {
                Text(schedule.enabled ? "Pause" : "Resume")
                    .foregroundStyle(PhrenTheme.textSecondary)
                    .frame(width: 72).frame(maxHeight: .infinity)
                    .background(PhrenTheme.surfaceRaised).contentShape(Rectangle())
            }
            .accessibilityIdentifier("schedule-pause:\(schedule.id)")

            Button { showDeleteConfirmation() } label: {
                Text("Delete")
                    .foregroundStyle(PhrenTheme.onAccent)
                    .frame(width: 72).frame(maxHeight: .infinity)
                    .background(PhrenTheme.danger).contentShape(Rectangle())
            }
            .accessibilityIdentifier("schedule-delete:\(schedule.id)")
        }
        .buttonStyle(.plain)
        .frame(minHeight: 104)
        .allowsHitTesting(isOpen)
        .accessibilityHidden(!isOpen)
    }

    private var deleteConfirmation: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Text("Delete this schedule?")
                .font(PhrenTypography.subheadline.weight(.semibold))
                .foregroundStyle(PhrenTheme.text)
            Spacer(minLength: PhrenTheme.Space.xs)
            Button("Keep") { cancelDelete() }
                .foregroundStyle(PhrenTheme.textSecondary)
                .frame(minWidth: 60, minHeight: 44)
            Button("Delete") {
                deleteTask?.cancel()
                onDelete()
            }
            .foregroundStyle(PhrenTheme.danger)
            .frame(minWidth: 60, minHeight: 44)
            .accessibilityIdentifier("schedule-delete-confirm:\(schedule.id)")
        }
        .padding(.horizontal, PhrenTheme.Space.medium)
        .frame(minHeight: 82)
        .sessionCard()
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .updating($dragOffset) { value, state, _ in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                state = value.translation.width
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let projected = offset + value.predictedEndTranslation.width
                let open = projected < -72
                animate { offset = open ? -144 : 0 }
            }
    }

    private var stateColor: Color {
        if state?.running == true { return PhrenTheme.stateWorking }
        if !schedule.enabled { return PhrenTheme.textDim }
        if state?.lastRun?.status == .failed { return PhrenTheme.stateWaiting }
        return PhrenTheme.stateDone
    }

    private var nextRunText: String {
        if !computerKnown { return "unknown computer" }
        if host == nil { return "\(schedule.computer) offline" }
        if !schedule.enabled { return "paused" }
        if case .once = schedule.every, state?.lastRun != nil, state?.nextRun == nil { return "done" }
        if let next = state?.nextRun ?? ScheduleWords.nextRun(schedule, after: .now, calendar: .current) {
            return ScheduleWords.relative(next, now: .now)
        }
        if case .once = schedule.every { return "done" }
        return "paused"
    }

    private var harnessName: String { ScheduleWords.harnessName(schedule.harness) }

    private var lastRunIcon: String {
        if state?.running == true { return "circle.fill" }
        return state?.lastRun?.status == .failed ? "xmark" : "checkmark"
    }

    private var lastRunColor: Color {
        if state?.running == true { return PhrenTheme.stateWorking }
        return state?.lastRun?.status == .failed ? PhrenTheme.danger : PhrenTheme.stateDone
    }

    private var accessibilityText: String {
        var parts = [schedule.name, nextRunText, schedule.computer, harnessName, ScheduleWords.describe(schedule)]
        if let run = state?.lastRun {
            parts.append("last run \(run.status.rawValue) \(ScheduleWords.relative(run.finishedAt ?? run.startedAt, now: .now))")
        }
        return parts.joined(separator: ", ")
    }

    private func launch() {
        launching = true
        Task {
            await onRun()
            launching = false
        }
    }

    private func closeSwipe() { animate { offset = 0 } }

    private func showDeleteConfirmation() {
        animate { offset = 0; confirmingDelete = true }
        deleteTask?.cancel()
        deleteTask = Task {
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            confirmingDelete = false
        }
    }

    private func cancelDelete() {
        deleteTask?.cancel()
        animate { confirmingDelete = false }
    }

    private func animate(_ changes: () -> Void) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18), changes)
    }
}

struct ScheduleRuntimeState: Sendable {
    let nextRun: Date?
    let lastRun: ScheduleRun?
    let running: Bool

    init(_ status: ScheduleStatus) {
        nextRun = status.nextRun
        lastRun = status.lastRun
        running = status.running
    }

    init(run: ScheduleRun, nextRun: Date?, running: Bool) {
        self.nextRun = nextRun
        lastRun = run
        self.running = running
    }
}

private struct ScheduleListEntry: Identifiable {
    let project: String
    let schedule: Schedule
    var id: String { SchedulesView.key(project: project, id: schedule.id) }
}

private struct ScheduleEditorSelection: Identifiable {
    let project: String
    let schedule: Schedule
    var id: String { SchedulesView.key(project: project, id: schedule.id) }
}
