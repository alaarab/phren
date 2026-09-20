import PhrenKit
import PhrenLive
import SwiftUI

struct ScheduleEditorView: View {
    let storeId: String
    let project: String?
    let schedule: Schedule?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var preferencesData = Data()

    @State private var name: String
    @State private var prompt: String
    @State private var selectedProject: String?
    @State private var computer: String
    @State private var harness: Schedule.Harness?
    @State private var modelID: String?
    @State private var customModel: String
    @State private var whenKind: WhenKind
    @State private var intervalMinutes: Int
    @State private var hour: Int
    @State private var minute: Int
    @State private var days: Set<Schedule.Weekday>
    @State private var onceDate: Date
    @State private var cron: String
    @State private var enabled: Bool
    @State private var models: [AgentModelChoice] = []
    @State private var loadingModels = false
    @State private var saving = false
    @State private var confirmingDelete = false
    @State private var deleteGeneration = 0
    @State private var openedContents: [String: String] = [:]
    @State private var openedProjects: Set<String> = []
    @State private var capturedOpeningState = false

    private enum WhenKind: String, Hashable {
        case interval, daily, weekly, once, cron
    }

    private struct ComputerChoice: Identifiable {
        let name: String
        let host: LiveHost?
        var id: String { ScheduleEditorView.canonical(name) }
    }

    init(storeId: String, project: String?, schedule: Schedule?) {
        self.storeId = storeId
        self.project = project
        self.schedule = schedule

        var kind = WhenKind.daily
        var interval = 360
        var hour = 7
        var minute = 30
        var days: Set<Schedule.Weekday> = [.mon, .tue, .wed, .thu, .fri]
        var once = Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now.addingTimeInterval(86_400)
        once = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: once) ?? once
        var cron = ""

        if let schedule {
            switch schedule.every {
            case .interval(let minutes):
                kind = .interval; interval = minutes
            case .daily(let scheduledHour, let scheduledMinute):
                kind = .daily; hour = scheduledHour; minute = scheduledMinute
            case .weekly(let scheduledDays, let scheduledHour, let scheduledMinute):
                kind = .weekly; days = scheduledDays; hour = scheduledHour; minute = scheduledMinute
            case .once(let date):
                kind = .once; once = date
            case .cron(let expression):
                kind = .cron; cron = expression
            }
        }

        _name = State(initialValue: schedule?.name ?? "")
        _prompt = State(initialValue: schedule?.prompt ?? "")
        _selectedProject = State(initialValue: project)
        _computer = State(initialValue: schedule?.computer ?? "")
        _harness = State(initialValue: schedule?.harness)
        _modelID = State(initialValue: schedule?.model)
        _customModel = State(initialValue: schedule?.model ?? "")
        _whenKind = State(initialValue: kind)
        _intervalMinutes = State(initialValue: interval)
        _hour = State(initialValue: hour)
        _minute = State(initialValue: minute)
        _days = State(initialValue: days)
        _onceDate = State(initialValue: once)
        _cron = State(initialValue: cron)
        _enabled = State(initialValue: schedule?.enabled ?? true)
    }

    private var snapshot: LocalStore.Snapshot { model.snapshot(for: storeId) }
    private var projects: [String] { snapshot.projects.map(\.name).sorted() }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(preferencesData) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }
    private var chosenHost: LiveHost? {
        hosts.first { host in
            [host.name, host.address].contains { Self.canonical($0) == Self.canonical(computer) }
        }
    }
    private var computerChoices: [ComputerChoice] {
        var choices = hosts.map { ComputerChoice(name: $0.name, host: $0) }
        var seen = Set(choices.map(\.id))
        for name in snapshot.machines.machines.keys.sorted() where seen.insert(Self.canonical(name)).inserted {
            choices.append(ComputerChoice(name: name, host: nil))
        }
        if !computer.isEmpty, seen.insert(Self.canonical(computer)).inserted {
            choices.append(ComputerChoice(name: computer, host: nil))
        }
        return choices
    }
    private var selectedProjectName: String? { project ?? selectedProject }
    private var modelLoadID: String {
        computer + "|" + (harness.map { ScheduleModelLoader.source(for: $0) } ?? "")
    }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasCapacity: Bool {
        guard schedule == nil, let selectedProjectName else { return true }
        return (snapshot.schedules[selectedProjectName]?.count ?? 0) < 64
    }
    private var whenIsValid: Bool {
        switch whenKind {
        case .interval: intervalMinutes >= 5
        case .daily: (0...23).contains(hour) && (0...59).contains(minute)
        case .weekly: !days.isEmpty && (0...23).contains(hour) && (0...59).contains(minute)
        case .once: true
        case .cron: CronPreview.next(cron, count: 3, from: .now, calendar: .current)?.count == 3
        }
    }
    private var canSave: Bool {
        !saving && hasCapacity && selectedProjectName != nil && (1...80).contains(trimmedName.count)
            && (1...8_000).contains(trimmedPrompt.count) && !computer.isEmpty && harness != nil && whenIsValid
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ActionErrorBanner()
            ScrollView {
                VStack(alignment: .leading, spacing: PhrenTheme.Space.section) {
                    nameGroup
                    promptGroup
                    if project == nil { projectGroup }
                    computerGroup
                    harnessGroup
                    if harness != nil { modelGroup }
                    whenGroup
                    enabledGroup
                    if schedule != nil { deleteGroup }
                }
                .padding(PhrenTheme.Space.large)
            }
            .accessibilityIdentifier("schedule-editor-scroll")
            .scrollDismissesKeyboard(.interactively)
        }
        .background(PhrenTheme.bg)
        .accessibilityIdentifier("schedule-editor")
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
        .task {
            captureOpeningState()
            if selectedProject == nil {
                selectedProject = schedule.flatMap { edited in
                    snapshot.schedules.first { _, schedules in
                        schedules.contains { $0.id == edited.id }
                    }?.key
                } ?? projects.first
            }
        }
        .task(id: modelLoadID) { await loadModels() }
    }

    private var header: some View {
        HStack(spacing: 0) {
            Button("Cancel") { dismiss() }
                .frame(width: 76, minHeight: 44, alignment: .leading)
                .accessibilityIdentifier("schedule-cancel")
            Spacer(minLength: 0)
            Text(schedule == nil ? "New schedule" : "Edit schedule")
                .font(PhrenTypography.subheadline.weight(.semibold))
                .foregroundStyle(PhrenTheme.text)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button("Save") { Task { await save() } }
                .foregroundStyle(canSave ? PhrenTheme.accentSolid : PhrenTheme.textDim)
                .frame(width: 76, minHeight: 44, alignment: .trailing)
                .disabled(!canSave)
                .accessibilityIdentifier("schedule-save")
        }
        .padding(.horizontal, PhrenTheme.Space.large)
        .frame(height: 56)
        .background(PhrenTheme.bg)
        .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 0.5) }
    }

    private var nameGroup: some View {
        editorGroup("Name") {
            TextField("Nightly test sweep", text: $name)
                .font(PhrenTypography.body)
                .foregroundStyle(PhrenTheme.text)
                .padding(.horizontal, PhrenTheme.Space.medium)
                .frame(minHeight: 44)
                .background(PhrenTheme.surfaceRaised,
                            in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
                .accessibilityIdentifier("schedule-name")
                .onChange(of: name) { _, value in if value.count > 80 { name = String(value.prefix(80)) } }
        }
    }

    private var promptGroup: some View {
        editorGroup("Prompt") {
            PhrenCodeField(text: $prompt, placeholder: "What should the agent do?")
                .accessibilityIdentifier("schedule-prompt")
                .onChange(of: prompt) { _, value in if value.count > 8_000 { prompt = String(value.prefix(8_000)) } }
            if prompt.count > 6_000 {
                Text("\(prompt.count) / 8000")
                    .font(PhrenTypography.monoCaption2)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    private var projectGroup: some View {
        editorGroup("Project") {
            ForEach(projects, id: \.self) { option in
                ChatQuestionOptionRow(label: option, selected: selectedProject == option) {
                    selectedProject = option
                    captureProject(option)
                }
                .accessibilityIdentifier("schedule-project:\(option)")
            }
        }
    }

    private var computerGroup: some View {
        editorGroup("Computer") {
            ForEach(computerChoices) { choice in
                ZStack(alignment: .leading) {
                    ChatQuestionOptionRow(
                        label: "     \(choice.name)",
                        selected: Self.canonical(computer) == choice.id
                    ) {
                        computer = choice.name
                        modelID = nil
                        customModel = ""
                    }
                    .accessibilityIdentifier("schedule-computer:\(choice.name)")
                    Circle()
                        .fill(choice.host.map { PhrenTheme.hostColor($0.color ?? LiveHost.defaultColor(for: $0.id)) }
                              ?? PhrenTheme.textDim)
                        .frame(width: 8, height: 8)
                        .padding(.leading, 45)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    if choice.host == nil {
                        Text("offline")
                            .font(PhrenTypography.caption)
                            .foregroundStyle(PhrenTheme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .padding(.trailing, PhrenTheme.Space.medium)
                            .allowsHitTesting(false)
                    }
                }
                .opacity(choice.host == nil ? 0.7 : 1)
            }
        }
    }

    private var harnessGroup: some View {
        editorGroup("Harness") {
            ForEach(Self.harnesses, id: \.self) { option in
                ZStack(alignment: .leading) {
                    ChatQuestionOptionRow(label: "       \(Self.harnessName(option))", selected: harness == option) {
                        harness = option
                        modelID = nil
                        customModel = ""
                    }
                    .accessibilityIdentifier("schedule-harness:\(ScheduleModelLoader.source(for: option))")
                    AgentProviderGlyph(source: ScheduleModelLoader.source(for: option), size: 18)
                        .padding(.leading, 43)
                        .allowsHitTesting(false)
                }
            }
        }
    }

    private var modelGroup: some View {
        editorGroup("Model") {
            if loadingModels {
                ForEach(0..<3, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous)
                        .fill(PhrenTheme.surfaceRaised.opacity(0.5))
                        .frame(height: 44)
                        .accessibilityHidden(true)
                }
            } else if chosenHost == nil {
                Text("Connect \(computer) to list models")
                    .font(PhrenTypography.subheadline)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            } else {
                modelRow(label: "Harness default", detail: nil, id: nil, isDefault: false)
                ForEach(models) { choice in
                    modelRow(label: choice.name, detail: choice.description, id: choice.argument,
                             isDefault: choice.isDefault)
                }
            }
            TextField("Model id", text: $customModel)
                .font(PhrenTypography.monoSubheadline)
                .foregroundStyle(PhrenTheme.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, PhrenTheme.Space.medium)
                .frame(minHeight: 44)
                .background(PhrenTheme.surfaceRaised,
                            in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
                .accessibilityIdentifier("schedule-model-custom")
                .onChange(of: customModel) { _, value in
                    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    modelID = trimmed.isEmpty ? nil : trimmed
                }
        }
    }

    private func modelRow(label: String, detail: String?, id: String?, isDefault: Bool) -> some View {
        ZStack(alignment: .trailing) {
            ChatQuestionOptionRow(label: label, detail: detail, selected: modelID == id) {
                modelID = id
                customModel = id ?? ""
            }
            .accessibilityIdentifier("schedule-model:\(id ?? "default")")
            if isDefault {
                PhrenChip(text: "default")
                    .padding(.trailing, PhrenTheme.Space.medium)
                    .allowsHitTesting(false)
            }
        }
    }

    private var whenGroup: some View {
        editorGroup("When") {
            PhrenIconSegment(items: [
                .init(value: .interval, icon: "repeat", label: "Every"),
                .init(value: .daily, icon: "sun.max", label: "Daily"),
                .init(value: .weekly, icon: "calendar", label: "Weekly"),
                .init(value: .once, icon: "1.circle", label: "Once"),
                .init(value: .cron, icon: "terminal", label: "Cron"),
            ], selection: $whenKind)
            .accessibilityIdentifier("schedule-every:\(whenKind.rawValue)")

            switch whenKind {
            case .interval:
                fieldRow("Interval") {
                    PhrenDurationField(minutes: $intervalMinutes)
                }
            case .daily:
                fieldRow("At") {
                    PhrenTimeField(hour: $hour, minute: $minute)
                }
            case .weekly:
                fieldRow("Days", alignment: .top) {
                    PhrenDayChips(days: $days)
                }
                fieldRow("At") {
                    PhrenTimeField(hour: $hour, minute: $minute)
                }
            case .once:
                fieldRow("On") {
                    PhrenDateField(date: $onceDate)
                }
            case .cron:
                fieldRow("Cron") {
                    TextField("0 7 * * 1-5", text: $cron)
                        .font(PhrenTypography.monoSubheadline)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, PhrenTheme.Space.medium)
                        .frame(minHeight: 44)
                        .background(PhrenTheme.surfaceRaised,
                                    in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
                        .accessibilityIdentifier("schedule-cron")
                }
                cronPreview
            }
        }
    }

    @ViewBuilder private var cronPreview: some View {
        let dates = CronPreview.next(cron, count: 3, from: .now, calendar: .current)
        fieldRow("Next", alignment: .top) {
            if let dates, dates.count == 3 {
                VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
                    ForEach(dates, id: \.self) { date in
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                .font(PhrenTypography.caption)
                .foregroundStyle(PhrenTheme.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("Not a valid cron line")
                    .font(PhrenTypography.caption)
                    .foregroundStyle(PhrenTheme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var enabledGroup: some View {
        editorGroup("Enabled") {
            HStack {
                Text("Enabled").font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
                Spacer()
                PhrenSwitch(isOn: $enabled)
            }
            .frame(minHeight: 44)
            .accessibilityIdentifier("schedule-enabled")
        }
    }

    private var deleteGroup: some View {
        Group {
            if confirmingDelete, let id = schedule?.id {
                HStack(spacing: PhrenTheme.Space.small) {
                    Text("Delete this schedule?")
                        .font(PhrenTypography.subheadline)
                        .foregroundStyle(PhrenTheme.text)
                    Spacer(minLength: PhrenTheme.Space.small)
                    Button("Keep") { confirmingDelete = false }
                        .frame(minHeight: 44)
                    Button("Delete", role: .destructive) { Task { await deleteSchedule() } }
                        .foregroundStyle(PhrenTheme.danger)
                        .frame(minHeight: 44)
                }
                .padding(.horizontal, PhrenTheme.Space.medium)
                .background(PhrenTheme.surfaceRaised,
                            in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
                .accessibilityIdentifier("schedule-delete-confirm:\(id)")
            } else if let id = schedule?.id {
                Button("Delete schedule", role: .destructive) { beginDeleteConfirmation() }
                    .font(PhrenTypography.body)
                    .foregroundStyle(PhrenTheme.danger)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(PhrenTheme.surfaceRaised,
                                in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
                    .accessibilityIdentifier("schedule-delete:\(id)")
            }
        }
    }

    private func editorGroup<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            Text(title).plainListSectionLabel()
            content()
        }
    }

    private func fieldRow<Content: View>(_ label: String, alignment: VerticalAlignment = .center,
                                         @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: alignment, spacing: PhrenTheme.Space.medium) {
            Text(label)
                .font(PhrenTypography.caption)
                .foregroundStyle(PhrenTheme.textMuted)
                .frame(width: 96, minHeight: 44, alignment: .leading)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func captureOpeningState() {
        guard !capturedOpeningState else { return }
        capturedOpeningState = true
        let names = Set(projects).union(project.map { [$0] } ?? [])
        openedProjects = names
        for name in names {
            if let content = snapshot.schedulesContent[name] { openedContents[name] = content }
        }
    }

    private func captureProject(_ name: String) {
        guard !openedProjects.contains(name) else { return }
        openedProjects.insert(name)
        if let content = snapshot.schedulesContent[name] { openedContents[name] = content }
    }

    private func loadModels() async {
        models = []
        guard let harness, let host = chosenHost else { loadingModels = false; return }
        loadingModels = true
        defer { loadingModels = false }
        do {
            models = try await ScheduleModelLoader.load(host: host, harness: harness)
        } catch {
            models = AgentModelChoice.choices(source: ScheduleModelLoader.source(for: harness))
        }
    }

    private func save() async {
        guard canSave, let selectedProjectName, let harness else { return }
        saving = true
        defer { saving = false }
        let now = Date()
        let current = snapshot.schedules[selectedProjectName] ?? []
        let value = Schedule(
            id: schedule?.id ?? newID(excluding: Set(current.map(\.id))),
            name: trimmedName,
            enabled: enabled,
            computer: computer,
            harness: harness,
            model: modelID,
            every: scheduleEvery,
            prompt: prompt,
            createdAt: schedule?.createdAt ?? now,
            updatedAt: now
        )
        var schedules = current
        if let index = schedules.firstIndex(where: { $0.id == value.id }) { schedules[index] = value }
        else { schedules.append(value) }
        await persist(schedules, project: selectedProjectName, dismissWhenDone: true)
    }

    private func deleteSchedule() async {
        guard let schedule, let selectedProjectName else { return }
        saving = true
        defer { saving = false }
        let schedules = (snapshot.schedules[selectedProjectName] ?? []).filter { $0.id != schedule.id }
        await persist(schedules, project: selectedProjectName, dismissWhenDone: true)
    }

    private func persist(_ schedules: [Schedule], project: String, dismissWhenDone: Bool) async {
        let expected = openedProjects.contains(project) ? openedContents[project] : snapshot.schedulesContent[project]
        let content = SchedulesFile.render(schedules, preserving: expected)
        do {
            try await model.enqueue(.saveSchedules(project: project, content: content, expectedContent: expected), in: storeId)
            model.lastActionError = nil
            await model.refresh()
            if dismissWhenDone { dismiss() }
        } catch {
            let message = error.localizedDescription
            model.lastActionError = message.localizedCaseInsensitiveContains("conflict")
                || message.localizedCaseInsensitiveContains("changed")
                ? "Schedules changed on another device. Reopen to edit."
                : message
        }
    }

    private var scheduleEvery: Schedule.Every {
        switch whenKind {
        case .interval: .interval(minutes: max(5, intervalMinutes))
        case .daily: .daily(hour: hour, minute: minute)
        case .weekly: .weekly(days: days, hour: hour, minute: minute)
        case .once: .once(onceDate)
        case .cron: .cron(cron.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func beginDeleteConfirmation() {
        deleteGeneration += 1
        let generation = deleteGeneration
        confirmingDelete = true
        Task {
            try? await Task.sleep(for: .seconds(6))
            guard deleteGeneration == generation else { return }
            confirmingDelete = false
        }
    }

    private func newID(excluding existing: Set<String>) -> String {
        for _ in 0..<8 {
            let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(8)
            if !existing.contains(String(id)) { return String(id) }
        }
        return String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(8))
    }

    private static let harnesses: [Schedule.Harness] = [.claude, .codex, .opencode]
    private static func harnessName(_ harness: Schedule.Harness) -> String {
        switch harness {
        case .claude: "Claude"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        }
    }
    private static func canonical(_ value: String) -> String {
        var result = value.lowercased()
        if result.hasSuffix(".local") { result.removeLast(".local".count) }
        return result
    }
}
