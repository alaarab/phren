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
/// color dots for the phone-local name color), and a Reset row at the bottom that
/// clears every override behind a PhrenDialog confirmation.
struct ProjectKnobsView: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var knobs = ProjectKnobs()
    @State private var baseline = ProjectKnobs()
    /// The project's name color, phone-local, so it is not part of `knobs`.
    @State private var nameColour: ProjectNameColor = .default
    @State private var nameColourHex = ""
    /// The raw `phren.project.yaml` the screen opened, carried into each write
    /// as its conflict check.
    @State private var expectedContent: String?
    @State private var confirmingReset = false
    @State private var showingNameColor = false

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
        .phrenColorSheet(isPresented: $showingNameColor, title: "Name color", selection: Binding(get: {
            nameColour.color
        }, set: { color in
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return }
            func channel(_ component: CGFloat) -> Int { Int((min(1, max(0, component)) * 255).rounded()) }
            chooseNameColour(.hex(String(format: "#%02X%02X%02X", channel(red), channel(green), channel(blue))))
        }), identifier: "knob-name-color-editor")
        .phrenDialog(isPresented: $confirmingReset, title: "Reset all knobs?",
                     message: "Clear every override so the project follows your global settings, and restore the default name color.",
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

    /// The project name's color everywhere it is drawn: the theme's own,
    /// one of the computer palette's eight, or any color from the picker or
    /// a hex. Phone-local, so it saves the moment it changes.
    private var nameColourRow: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            HStack(spacing: PhrenTheme.Space.small) {
                Text("Name color").font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
                Spacer(minLength: PhrenTheme.Space.small)
                Text(project).font(PhrenTypography.subheadline.weight(.semibold)).foregroundStyle(nameColour.color).lineLimit(1)
                    .accessibilityIdentifier("knob-value:nameColour")
            }
            .frame(minHeight: 32)
            // The same row a computer gets: 28pt dots, a ring on the chosen one.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(nameColourChoices, id: \.id) { choice in
                        Button { chooseNameColour(choice.value) } label: {
                            ZStack {
                                Circle().fill(choice.value.color).frame(width: 28, height: 28)
                                if choice.value == nameColour {
                                    Circle().stroke(PhrenTheme.text, lineWidth: 2).frame(width: 34, height: 34)
                                }
                            }
                            .frame(width: 40, height: 40)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(choice.title)
                        .accessibilityAddTraits(choice.value == nameColour ? [.isSelected] : [])
                        .accessibilityIdentifier("knob:nameColour:\(choice.id)")
                    }
                }
                .padding(.horizontal, 2)
            }
            .accessibilityIdentifier("knob:nameColour")
            HStack(spacing: PhrenTheme.Space.medium) {
                PhrenColorButton(title: "Custom", color: nameColour.color, identifier: "knob:nameColour:custom") {
                    showingNameColor = true
                }
                HStack(spacing: 1) {
                    Text("#").foregroundStyle(PhrenTheme.textDim)
                    TextField("RRGGBB", text: $nameColourHex)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .frame(width: 72)
                        .onSubmit { if let hex = ProjectNameColor.normalized(nameColourHex) { chooseNameColour(.hex(hex)) } }
                        .accessibilityIdentifier("knob:nameColour:hex")
                }
                .font(PhrenTypography.monoCaption)
                Spacer()
            }
            .frame(minHeight: 32)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, PhrenTheme.Space.medium)
        .padding(.vertical, PhrenTheme.Space.small)
        .sessionCard()
    }

    private var nameColourChoices: [PhrenOption<ProjectNameColor>] {
        [PhrenOption(id: "default", value: .default, title: "Default")]
            + ProjectNameColor.palette.enumerated().map { index, hex in
                PhrenOption(id: hex, value: .hex(hex), title: ProjectNameColor.paletteNames[index])
            }
    }

    private func chooseNameColour(_ value: ProjectNameColor) {
        nameColour = value
        nameColourHex = value.hexValue.map { String($0.dropFirst()) } ?? ""
        ProjectNameColor.set(value, storeId: storeId, project: project)
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
        nameColourHex = nameColour.hexValue.map { String($0.dropFirst()) } ?? ""
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

    /// Back to "Inherit global" everywhere, plus the default name color.
    /// The `knobs` assignment rides the same per-change save path as a tap.
    private func resetAll() {
        chooseNameColour(.default)
        knobs = ProjectKnobs()
    }
}
