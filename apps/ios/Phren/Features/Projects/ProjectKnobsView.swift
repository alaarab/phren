import SwiftUI
import PhrenKit

/// Per-project overrides for the knobs the CLI reads from
/// `phren.project.yaml`. Every picker's first option is "Inherit global"
/// (nil), which removes the key from the file; the CLI then falls back to the
/// global setting. Saving is per change — there is no draft to lose.
struct ProjectKnobsView: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var knobs = ProjectKnobs()
    @State private var baseline = ProjectKnobs()
    /// The raw `phren.project.yaml` the screen opened, carried into each write
    /// as its conflict check.
    @State private var expectedContent: String?

    var body: some View {
        NavigationStack {
            PhrenForm {
                Section {
                    Picker("Finding sensitivity", selection: $knobs.findingSensitivity) {
                        Text("Inherit global").tag(ProjectKnobs.FindingSensitivity?.none)
                        ForEach(ProjectKnobs.FindingSensitivity.allCases, id: \.self) { value in
                            Text(value.rawValue.capitalized).tag(ProjectKnobs.FindingSensitivity?.some(value))
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("knob-findingSensitivity")

                    Picker("Proactivity", selection: $knobs.proactivity) {
                        Text("Inherit global").tag(ProjectKnobs.Proactivity?.none)
                        ForEach(ProjectKnobs.Proactivity.allCases, id: \.self) { value in
                            Text(value.rawValue.capitalized).tag(ProjectKnobs.Proactivity?.some(value))
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("knob-proactivity")

                    Picker("Proactivity for findings", selection: $knobs.proactivityFindings) {
                        Text("Inherit global").tag(ProjectKnobs.Proactivity?.none)
                        ForEach(ProjectKnobs.Proactivity.allCases, id: \.self) { value in
                            Text(value.rawValue.capitalized).tag(ProjectKnobs.Proactivity?.some(value))
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("knob-proactivityFindings")

                    Picker("Proactivity for tasks", selection: $knobs.proactivityTask) {
                        Text("Inherit global").tag(ProjectKnobs.Proactivity?.none)
                        ForEach(ProjectKnobs.Proactivity.allCases, id: \.self) { value in
                            Text(value.rawValue.capitalized).tag(ProjectKnobs.Proactivity?.some(value))
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("knob-proactivityTask")

                    Picker("Task mode", selection: $knobs.taskMode) {
                        Text("Inherit global").tag(ProjectKnobs.TaskMode?.none)
                        ForEach(ProjectKnobs.TaskMode.allCases, id: \.self) { value in
                            Text(value.rawValue.capitalized).tag(ProjectKnobs.TaskMode?.some(value))
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("knob-taskMode")
                } footer: {
                    Text("Saved to this project's phren.project.yaml; empty means the global setting.")
                        .font(.caption)
                        .foregroundStyle(PhrenTheme.textMuted)
                }
            }
            .overlay(alignment: .topLeading) {
                Color.clear.frame(width: 1, height: 1)
                    .accessibilityElement().accessibilityLabel("Project knobs")
                    .accessibilityIdentifier("project-knobs")
            }
            .navigationTitle("Knobs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { load() }
            .onChange(of: knobs) { _, new in save(new) }
        }
    }

    private func load() {
        let snapshot = model.snapshot(for: storeId)
        let loaded = snapshot.projectKnobs[project] ?? ProjectKnobs()
        knobs = loaded
        baseline = loaded
        expectedContent = snapshot.projectConfigs[project]
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
