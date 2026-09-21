import PhrenKit
import PhrenLive
import SwiftUI

struct ScheduleEditorView: View {
    let storeId: String
    let project: String?
    let schedule: Schedule?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
    @State private var validTime = true
    @State private var validDuration = true
    @State private var validDate = true
    @State private var modelsUnavailable = false
    @State private var enabled: Bool
    @State private var notify: Set<Schedule.Notify>
    @State private var showProject = false
    @State private var showComputer = false
    @State private var showHarness = false
    @State private var showModel = false
    @State private var showNotify = false
    @State private var models: [AgentModelChoice] = []
    @State private var loadingModels = false
    @State private var saving = false
    @State private var confirmingDelete = false
    @State private var deleteGeneration = 0
    @State private var openedContents: [String: String] = [:]
    @State private var openedProjects: Set<String> = []
    @State private var capturedOpeningState = false
    @FocusState private var typing: Bool

    private enum WhenKind: String, Hashable {
        case interval, daily, weekly, once, cron
    }

    private struct ComputerChoice: Identifiable {
        let name: String
        let host: LiveHost?
        var id: String { SchedulesView.canonicalHost(name) }
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
        _notify = State(initialValue: schedule?.notify ?? Schedule.Notify.defaults)
    }

    private var snapshot: LocalStore.Snapshot { model.snapshot(for: storeId) }
    private var projects: [String] { snapshot.projects.map(\.name).sorted() }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(preferencesData) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }
    private var chosenHost: LiveHost? {
        hosts.first { host in
            [host.name, host.address].contains { SchedulesView.canonicalHost($0) == SchedulesView.canonicalHost(computer) }
        }
    }
    private var computerChoices: [ComputerChoice] {
        let online = Set(SessionOverviewMonitor.shared.screen.computers.filter(\.fresh).map(\.id))
        var choices = hosts.sorted { online.contains($0.id) && !online.contains($1.id) }.map { ComputerChoice(name: $0.name, host: $0) }
        var seen = Set(choices.map(\.id))
        for name in snapshot.machines.machines.keys.sorted() where seen.insert(SchedulesView.canonicalHost(name)).inserted {
            choices.append(ComputerChoice(name: name, host: nil))
        }
        if !computer.isEmpty, seen.insert(SchedulesView.canonicalHost(computer)).inserted {
            choices.append(ComputerChoice(name: computer, host: nil))
        }
        return choices
    }
    private var selectedProjectName: String? { project ?? selectedProject }

    private var projectOptions: [PhrenOption<String?>] {
        projects.map { PhrenOption(id: $0, value: $0, title: $0) }
    }
    private var computerOptions: [PhrenOption<String>] {
        computerChoices.map { choice in
            PhrenOption(
                id: choice.name, value: choice.name, title: choice.name,
                glyph: choice.host.map { host in
                    AnyView(Circle().fill(PhrenTheme.hostColor(host.color ?? LiveHost.defaultColor(for: host.id)))
                        .frame(width: 8, height: 8).padding(.top, PhrenTheme.Space.xs))
                },
                trailing: choice.host == nil ? AnyView(PhrenOptionRow.trailingCaption("offline")) : nil,
                muted: choice.host == nil
            )
        }
    }
    private var harnessOptions: [PhrenOption<Schedule.Harness?>] {
        Self.harnesses.map { option in
            PhrenOption(id: option.rawValue, value: option, title: ScheduleWords.harnessName(option),
                        glyph: AnyView(AgentProviderGlyph(source: option.rawValue, size: 18)))
        }
    }
    /// "Harness default" (nil) first, then the computer's catalogue while it is
    /// connected, then any custom id the user typed while offline.
    private var modelOptions: [PhrenOption<String?>] {
        var options: [PhrenOption<String?>] = [.init(id: "default", value: nil, title: "Harness default")]
        if chosenHost != nil, !modelsUnavailable {
            options += models.map { choice in
                PhrenOption(id: choice.argument, value: choice.argument, title: choice.name,
                            caption: choice.description,
                            trailing: choice.isDefault ? AnyView(PhrenChip(text: "default")) : nil)
            }
        }
        if !customModel.isEmpty, !options.contains(where: { $0.value == customModel }) {
            options.append(.init(id: customModel, value: customModel, title: customModel))
        }
        return options
    }
    private var notifyOptions: [PhrenOption<Schedule.Notify>] {
        Schedule.Notify.allCases.map { option in
            PhrenOption(id: option.rawValue, value: option, title: Self.notifyTitle(option))
        }
    }
    private static func notifyTitle(_ notify: Schedule.Notify) -> String {
        switch notify {
        case .start: return "Start"
        case .finish: return "Finish"
        case .failure: return "Failure"
        }
    }
    private var modelsLoading: Bool { loadingModels && chosenHost != nil && !modelsUnavailable }
    private var computerOffline: Bool { chosenHost == nil || modelsUnavailable }
    private var modelLoadID: String {
        computer + "|" + (harness.map { $0.rawValue } ?? "")
    }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasCapacity: Bool {
        guard schedule == nil, let selectedProjectName else { return true }
        return (snapshot.schedules[selectedProjectName]?.count ?? 0) < 64
    }
    private var whenIsValid: Bool {
        switch whenKind {
        case .interval: validDuration && intervalMinutes >= 5
        case .daily: validTime && (0...23).contains(hour) && (0...59).contains(minute)
        case .weekly: validTime && !days.isEmpty && (0...23).contains(hour) && (0...59).contains(minute)
        case .once: validDate
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
            PhrenScreen {
                nameGroup
                promptGroup
                targetsSection
                whenGroup
                if schedule != nil { deleteGroup }
            }
            .accessibilityIdentifier("schedule-editor-scroll")
            .scrollDismissesKeyboard(.immediately)
        }
        .background(PhrenTheme.bg)
        // The container id would hide the scroller's and rows' ids from UI tests.
        .phrenContainerMarker("schedule-editor", label: schedule == nil ? "New schedule" : "Edit schedule")
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
        .phrenSingleSelectSheet(isPresented: $showProject, title: "Project", options: projectOptions,
                                selection: $selectedProject, rowPrefix: "schedule-project")
        .phrenSingleSelectSheet(isPresented: $showComputer, title: "Computer", options: computerOptions,
                                selection: $computer, rowPrefix: "schedule-computer")
        .phrenSingleSelectSheet(isPresented: $showHarness, title: "Harness", options: harnessOptions,
                                selection: $harness, rowPrefix: "schedule-harness")
        .phrenSingleSelectSheet(isPresented: $showModel, title: "Model", options: modelOptions,
                                selection: $modelID, rowPrefix: "schedule-model",
                                loading: modelsLoading, loadingLabel: "Loading models…",
                                message: computerOffline ? "Connect \(computer) to list models" : nil,
                                footer: computerOffline ? AnyView(modelCustomField) : nil)
        .phrenMultiSelectSheet(isPresented: $showNotify, title: "Notify", options: notifyOptions,
                               selection: $notify, rowPrefix: "schedule-notify")
        .onChange(of: computer) { _, _ in
            typing = false
            modelID = nil
            customModel = ""
        }
        .onChange(of: harness) { _, _ in
            typing = false
            modelID = nil
            customModel = ""
        }
        .onChange(of: selectedProject) { _, value in
            typing = false
            if let value { captureProject(value) }
        }
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
        PhrenSheetHeader(title: schedule == nil ? "New schedule" : "Edit schedule",
                         trailingTitle: "Save", canSave: canSave, identifierPrefix: "schedule",
                         cancel: { dismiss() }, save: { Task { await save() } })
    }

    private var nameGroup: some View {
        PhrenGroup("Name", identifier: "schedule-group:name") {
            TextField("Nightly test sweep", text: $name)
                .focused($typing)
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
        PhrenGroup("Prompt", identifier: "schedule-group:prompt") {
            PhrenCodeField(text: $prompt, placeholder: "What should the agent do?")
                .focused($typing)
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

    /// Computer, harness, model, notify and (from the all-projects list)
    /// project as compact labelled drop-down rows instead of long lists,
    /// so the whole editor fits one screen.
    private var targetsSection: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            if project == nil {
                fieldRow("Project") {
                    PhrenSingleSelect(options: projectOptions, selection: $selectedProject,
                                      placeholder: "Choose a project", identifier: "schedule-project",
                                      isPresented: $showProject)
                }
            }
            fieldRow("Computer") {
                PhrenSingleSelect(options: computerOptions, selection: $computer,
                                  placeholder: "Choose a computer", identifier: "schedule-computer",
                                  isPresented: $showComputer)
            }
            fieldRow("Harness") {
                PhrenSingleSelect(options: harnessOptions, selection: $harness,
                                  placeholder: "Choose a harness", identifier: "schedule-harness",
                                  isPresented: $showHarness)
            }
            if harness != nil, !computer.isEmpty {
                fieldRow("Model") {
                    PhrenSingleSelect(options: modelOptions, selection: $modelID,
                                      placeholder: "Harness default", identifier: "schedule-model",
                                      isPresented: $showModel)
                }
            }
            fieldRow("Notify") {
                PhrenMultiSelect(options: notifyOptions, selection: $notify, allLabel: "All",
                                 identifier: "schedule-notify", isPresented: $showNotify)
            }
        }
    }

    private var modelCustomField: some View {
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

    private var whenGroup: some View {
        PhrenGroup("When", identifier: "schedule-group:when") {
            PhrenIconSegment(items: [
                .init(value: .interval, icon: "repeat", label: "Every"),
                .init(value: .daily, icon: "sun.max", label: "Daily"),
                .init(value: .weekly, icon: "calendar", label: "Weekly"),
                .init(value: .once, icon: "1.circle", label: "Once"),
                .init(value: .cron, icon: "terminal", label: "Cron"),
            ], selection: $whenKind, identifier: { "schedule-every:\($0.rawValue)" })

            switch whenKind {
            case .interval:
                fieldRow("Interval") {
                    PhrenDurationField(minutes: $intervalMinutes, isValid: $validDuration)
                }
            case .daily:
                fieldRow("At") {
                    PhrenTimeField(hour: $hour, minute: $minute, isValid: $validTime)
                }
            case .weekly:
                fieldRow("Days", alignment: .top) {
                    PhrenDayChips(days: $days)
                }
                fieldRow("At") {
                    PhrenTimeField(hour: $hour, minute: $minute, isValid: $validTime)
                }
            case .once:
                fieldRow("On", stacked: true) {
                    PhrenDateField(date: $onceDate, isValid: $validDate)
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
            switchRow("Enabled", identifier: "schedule-enabled", isOn: $enabled)
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

    private func switchRow(_ label: String, identifier: String, isOn: Binding<Bool>) -> some View {
        HStack {
            Text(label).font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
            Spacer()
            PhrenSwitch(isOn: isOn, label: label)
                .accessibilityIdentifier(identifier)
        }
        .frame(minHeight: 44)
    }

    private var deleteGroup: some View {
        Group {
            if confirmingDelete, let id = schedule?.id {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                    : AnyLayout(HStackLayout(spacing: 8))
                layout {
                    Text("Delete this schedule?")
                        .font(PhrenTypography.subheadline)
                        .foregroundStyle(PhrenTheme.text)
                    Spacer(minLength: PhrenTheme.Space.small)
                    Button { confirmingDelete = false } label: {
                        Text("Keep").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    Button(role: .destructive) { Task { await deleteSchedule() } } label: {
                        Text("Delete").foregroundStyle(PhrenTheme.danger)
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("schedule-delete-confirm:\(id)")
                }
                .padding(.horizontal, PhrenTheme.Space.medium)
                .background(PhrenTheme.surfaceRaised,
                            in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
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

    private func fieldRow<Content: View>(_ label: String, alignment: VerticalAlignment = .center, stacked: Bool = false,
                                         @ViewBuilder content: () -> Content) -> some View {
        let vertical = stacked || dynamicTypeSize.isAccessibilitySize
        let layout = vertical
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: PhrenTheme.Space.small))
            : AnyLayout(HStackLayout(alignment: alignment, spacing: PhrenTheme.Space.medium))
        return layout {
            Text(label)
                .font(PhrenTypography.caption)
                .foregroundStyle(PhrenTheme.textMuted)
                .frame(width: vertical ? nil : 96, alignment: .leading)
                .frame(minHeight: 44, alignment: .leading)
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
        modelsUnavailable = false
        let loadID = modelLoadID
        guard let harness, let host = chosenHost else { loadingModels = false; return }
        loadingModels = true
        defer { if loadID == modelLoadID { loadingModels = false } }
        do {
            let choices = try await ScheduleModelLoader.load(host: host, harness: harness)
            guard !Task.isCancelled, loadID == modelLoadID else { return }
            models = choices
        } catch {
            guard !Task.isCancelled, loadID == modelLoadID else { return }
            modelsUnavailable = true
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
            notify: notify,
            every: scheduleEvery,
            prompt: prompt,
            createdAt: schedule?.createdAt ?? now,
            updatedAt: now
        )
        var schedules = current
        if let index = schedules.firstIndex(where: { $0.id == value.id }) { schedules[index] = value }
        else { schedules.append(value) }
        await persist(schedules, project: selectedProjectName)
    }

    private func deleteSchedule() async {
        guard let schedule, let selectedProjectName else { return }
        saving = true
        defer { saving = false }
        let schedules = (snapshot.schedules[selectedProjectName] ?? []).filter { $0.id != schedule.id }
        await persist(schedules, project: selectedProjectName)
    }

    private func persist(_ schedules: [Schedule], project: String) async {
        let expected = openedProjects.contains(project) ? openedContents[project] : snapshot.schedulesContent[project]
        let content = SchedulesFile.render(schedules, preserving: expected)
        do {
            try await model.enqueue(.saveSchedules(project: project, content: content, expectedContent: expected), in: storeId)
            model.lastActionError = nil
            await model.refresh()
            dismiss()
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
        var id = Schedule.generateID()
        while existing.contains(id) { id = Schedule.generateID() }
        return id
    }

    private static let harnesses: [Schedule.Harness] = [.claude, .codex, .opencode]
}
