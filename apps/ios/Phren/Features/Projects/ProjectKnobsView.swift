import PhrenKit
import SwiftUI

/// Per-project overrides for the knobs the CLI reads from
/// `phren.project.yaml`. Each choice includes "Inherit global" (nil), which
/// removes the key from the file; the CLI then falls back to the global
/// setting. Saving is per change, so there is no draft to lose.
///
/// The screen is one plain list: `plainListSectionLabel()` headers over
/// `sessionCard()` rows, every knob a row with a one-line caption and its own
/// control (a PhrenStepSlider across the enumerations so every stop is visible,
/// colour dots for the phone-local name colour), and a Reset row at the bottom that
/// clears every override behind a PhrenDialog confirmation.
struct ProjectKnobsView: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var knobs = ProjectKnobs()
    @State private var baseline = ProjectKnobs()
    /// The project's name colour, phone-local, so it is not part of `knobs`.
    @State private var nameColour: ProjectNameColor = .default
    /// The raw `phren.project.yaml` the screen opened, carried into each write
    /// as its conflict check.
    @State private var expectedContent: String?
    @State private var confirmingReset = false

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    sectionLabel("Findings", id: "findings")
                    knobSlider(title: "Finding sensitivity", caption: "How readily new findings are kept", options: findingSensitivityOptions,
                               selection: $knobs.findingSensitivity, key: "findingSensitivity")

                    sectionLabel("Proactivity", id: "proactivity")
                    knobSlider(title: "Proactivity", caption: "The base auto-capture level", options: proactivityOptions,
                               selection: $knobs.proactivity, key: "proactivity")
                    knobSlider(title: "Proactivity for findings", caption: "Auto-capture for findings only", options: proactivityFindingsOptions,
                               selection: $knobs.proactivityFindings, key: "proactivityFindings")
                    knobSlider(title: "Proactivity for tasks", caption: "Auto-capture for tasks only", options: proactivityTaskOptions,
                               selection: $knobs.proactivityTask, key: "proactivityTask")

                    sectionLabel("Tasks", id: "tasks")
                    knobSlider(title: "Task mode", caption: "How new tasks are filed", options: taskModeOptions,
                               selection: $knobs.taskMode, key: "taskMode")

                    sectionLabel("Appearance", id: "appearance")
                    nameColourRow

                    resetRow
                }
                .padding(.horizontal, 14)
                .padding(.bottom, PhrenTheme.Space.section)
            }
            .accessibilityIdentifier("knobs-scroll")
        }
        .background(PhrenTheme.bg.ignoresSafeArea())
        .phrenContainerMarker("project-knobs", label: "Project knobs")
        .phrenDialog(isPresented: $confirmingReset, title: "Reset all knobs?",
                     message: "Clear every override so the project follows your global settings, and restore the default name colour.",
                     actions: resetActions, identifier: "knobs-reset-dialog")
        .task { load() }
        .onChange(of: knobs) { _, new in save(new) }
    }

    private var header: some View {
        // Every change is already saved, so there is nothing to cancel.
        PhrenSheetHeader(title: "Knobs", save: { dismiss() })
    }

    private func sectionLabel(_ title: String, id: String) -> some View {
        Text(title)
            .plainListSectionLabel()
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("knobs-section:\(id)")
    }

    /// One knob per card, dense: the title and the current value on one
    /// line (a reset glyph beside it when the project overrides the global
    /// value), the slider under it with every stop labelled. What the knob
    /// affects is the accessibility hint, not a second line.
    private func knobSlider<Value: Hashable>(title: String, caption: String, options: [PhrenOption<Value?>],
                                             selection: Binding<Value?>, key: String) -> some View {
        let current = options.first { $0.value == selection.wrappedValue }?.title ?? ""
        return VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            HStack(spacing: PhrenTheme.Space.small) {
                Text(title).font(PhrenTypography.body).foregroundStyle(PhrenTheme.text).lineLimit(1)
                Spacer(minLength: PhrenTheme.Space.small)
                Text(current).font(PhrenTypography.subheadline.weight(.medium))
                    .foregroundStyle(selection.wrappedValue == nil ? PhrenTheme.textMuted : PhrenTheme.accent)
                    .lineLimit(1)
                    .accessibilityIdentifier("knob-value:\(key)")
                if selection.wrappedValue != nil {
                    Button { selection.wrappedValue = nil } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(PhrenTypography.icon(13, weight: .semibold))
                            .foregroundStyle(PhrenTheme.textMuted)
                            .frame(width: 32, height: 32).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Inherit global \(title.lowercased())")
                    .accessibilityIdentifier("knob-reset:\(key)")
                }
            }
            .frame(minHeight: 32)
            PhrenStepSlider(options: options, selection: selection, identifier: "knob:\(key)")
                .accessibilityLabel(title)
                .accessibilityHint(caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, PhrenTheme.Space.medium)
        .padding(.vertical, PhrenTheme.Space.small)
        .sessionCard()
    }

    /// The project name's colour everywhere it is drawn. Phone-local, so it
    /// saves the moment a dot is chosen and never leaves this device.
    private var nameColourRow: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
                Text("Name colour").font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
                Text("This project's colour on lists and headers")
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(1).fixedSize(horizontal: false, vertical: true)
            }
            PhrenColorDotRow(
                items: ProjectNameColor.allCases.map {
                    PhrenOption(id: $0.rawValue, value: $0, title: $0.title)
                },
                selection: Binding(get: { nameColour }, set: { value in
                    nameColour = value
                    ProjectNameColor.set(value, storeId: storeId, project: project)
                }),
                identifier: "knob:nameColour",
                color: { $0.color }
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(PhrenTheme.Space.medium)
        .frame(minHeight: 44, alignment: .leading)
        .sessionCard()
    }

    private var resetRow: some View {
        Button { confirmingReset = true } label: {
            VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
                Text("Reset").font(PhrenTypography.body).foregroundStyle(PhrenTheme.danger)
                Text("Clear every override for this project")
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(PhrenTheme.Space.medium)
            .frame(minHeight: 44, alignment: .leading)
            .sessionCard()
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("knobs-reset")
        .padding(.top, PhrenTheme.Space.small)
    }

    private var resetActions: [PhrenDialog.Action] {
        [
            .init(id: "reset", title: "Reset", role: .destructive) { resetAll() },
            .init(id: "keep", title: "Keep", role: .cancel) {},
        ]
    }

    private var findingSensitivityOptions: [PhrenOption<ProjectKnobs.FindingSensitivity?>] {
        inheritedOptions(ProjectKnobs.FindingSensitivity.allCases)
    }

    /// Sliders ascend: low on the left, high on the right.
    private var proactivityOptions: [PhrenOption<ProjectKnobs.Proactivity?>] {
        inheritedOptions(ProjectKnobs.Proactivity.allCases.reversed())
    }

    private var proactivityFindingsOptions: [PhrenOption<ProjectKnobs.Proactivity?>] { proactivityOptions }

    private var proactivityTaskOptions: [PhrenOption<ProjectKnobs.Proactivity?>] { proactivityOptions }

    private var taskModeOptions: [PhrenOption<ProjectKnobs.TaskMode?>] {
        inheritedOptions(ProjectKnobs.TaskMode.allCases)
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

    /// Back to "Inherit global" everywhere, plus the default name colour.
    /// The `knobs` assignment rides the same per-change save path as a tap.
    private func resetAll() {
        nameColour = .default
        ProjectNameColor.set(.default, storeId: storeId, project: project)
        knobs = ProjectKnobs()
    }
}
