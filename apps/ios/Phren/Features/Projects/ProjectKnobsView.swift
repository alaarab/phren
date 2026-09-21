import SwiftUI
import PhrenKit

/// Per-project overrides for the knobs the CLI reads from
/// `phren.project.yaml`. Each group's first option is "Inherit global" (nil),
/// which removes the key from the file; the CLI then falls back to the global
/// setting. Saving is per change, so there is no draft to lose.
struct ProjectKnobsView: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var knobs = ProjectKnobs()
    @State private var baseline = ProjectKnobs()
    /// The project's name colour, phone-local, so it is not part of `knobs`.
    @State private var nameColour: ProjectNameColor = .default
    /// The raw `phren.project.yaml` the screen opened, carried into each write
    /// as its conflict check.
    @State private var expectedContent: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            PhrenScreen {
                findingSensitivityOptions
                proactivityOptions(
                    title: "Proactivity",
                    key: "proactivity",
                    selection: knobs.proactivity
                ) { knobs.proactivity = $0 }
                proactivityOptions(
                    title: "Proactivity for findings",
                    key: "proactivityFindings",
                    selection: knobs.proactivityFindings
                ) { knobs.proactivityFindings = $0 }
                proactivityOptions(
                    title: "Proactivity for tasks",
                    key: "proactivityTask",
                    selection: knobs.proactivityTask
                ) { knobs.proactivityTask = $0 }
                taskModeOptions
                nameColourOptions

                Text("Changes save automatically. Inherit global uses your shared setting.")
                    .font(PhrenTheme.Font.caption)
                    .foregroundStyle(PhrenTheme.textMuted)
            }
        }
        .background(PhrenTheme.bg.ignoresSafeArea())
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement().accessibilityLabel("Project knobs")
                .accessibilityIdentifier("project-knobs")
        }
        .task { load() }
        .onChange(of: knobs) { _, new in save(new) }
    }

    private var header: some View {
        // Every change is already saved, so there is nothing to cancel.
        PhrenSheetHeader(title: "Knobs", save: { dismiss() })
    }

    private var findingSensitivityOptions: some View {
        PhrenGroup("Finding sensitivity", identifier: "knob-findingSensitivity") {
            PhrenOptionGroup(options: inheritedOptions(ProjectKnobs.FindingSensitivity.allCases),
                             selection: $knobs.findingSensitivity, identifier: "knob-findingSensitivity")
        }
    }

    private func proactivityOptions(
        title: String,
        key: String,
        selection: ProjectKnobs.Proactivity?,
        select: @escaping (ProjectKnobs.Proactivity?) -> Void
    ) -> some View {
        PhrenGroup(title, identifier: "knob-\(key)") {
            PhrenOptionGroup(options: inheritedOptions(ProjectKnobs.Proactivity.allCases),
                             selection: Binding(get: { selection }, set: select), identifier: "knob-\(key)")
        }
    }

    private var taskModeOptions: some View {
        PhrenGroup("Task mode", identifier: "knob-taskMode") {
            PhrenOptionGroup(options: inheritedOptions(ProjectKnobs.TaskMode.allCases),
                             selection: $knobs.taskMode, identifier: "knob-taskMode")
        }
    }

    /// The project name's colour everywhere it is drawn. Phone-local, so it
    /// saves the moment a dot is chosen and never leaves this device.
    private var nameColourOptions: some View {
        PhrenGroup("Name colour", identifier: "knob-nameColour") {
            PhrenColorDotRow(
                items: ProjectNameColor.allCases.map {
                    PhrenOption(id: $0.rawValue, value: $0, title: $0.title)
                },
                selection: Binding(get: { nameColour }, set: { value in
                    nameColour = value
                    ProjectNameColor.set(value, storeId: storeId, project: project)
                }),
                identifier: "knob-nameColour",
                color: { $0.color }
            )
        }
    }

    private func inheritedOptions<Value: RawRepresentable & Hashable>(_ values: [Value]) -> [PhrenOption<Value?>]
        where Value.RawValue == String {
        [PhrenOption<Value?>(id: "inherit", value: nil, title: "Inherit global")]
            + values.map { PhrenOption(id: $0.rawValue, value: Optional($0), title: $0.rawValue.capitalized) }
    }

    private func load() {
        let snapshot = model.snapshot(for: storeId)
        let loaded = snapshot.projectKnobs[project] ?? ProjectKnobs()
        knobs = loaded
        baseline = loaded
        expectedContent = snapshot.projectConfigs[project]
        nameColour = ProjectNameColor.stored(storeId: storeId, project: project)
    }

    private func save(_ new: ProjectKnobs) {
        // The load itself changes `knobs`; only a real edit is a write.
        guard new != baseline else { return }
        let previous = expectedContent
        expectedContent = new.apply(to: previous ?? "")
        baseline = new
        Task {
            await model.perform(
                .setProjectKnobs(project: project, knobs: new, expectedContent: previous),
                in: storeId
            )
        }
    }
}
