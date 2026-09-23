import SwiftUI
import PhrenKit

/// Task composer with an explicit destination picker when the target is
/// ambiguous (multiple stores/projects).
struct AddTaskSheet: View {
    struct Target: Identifiable, Hashable {
        let storeId: String
        let storeName: String
        let project: String
        var id: String { "\(storeId)|\(project)" }
    }

    let scope: TaskListView.Scope
    let targets: [Target]

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var selectedTarget: Target?
    @State private var showingTarget = false

    init(scope: TaskListView.Scope, targets: [(storeId: String, storeName: String, project: String)]) {
        self.scope = scope
        self.targets = targets.map { Target(storeId: $0.storeId, storeName: $0.storeName, project: $0.project) }
    }

    private var fixedTarget: (storeId: String, project: String)? {
        if case .project(let storeId, let project) = scope { return (storeId, project) }
        if targets.count == 1 { return (targets[0].storeId, targets[0].project) }
        return nil
    }

    private func targetLabel(_ target: Target) -> String {
        model.hasMultipleStores ? "\(target.project) · \(target.storeName)" : target.project
    }

    var body: some View {
        NavigationStack {
            PhrenForm {
                PhrenTextField("Task", text: $text, axis: .vertical, surface: .bare)
                    .lineLimit(2...6)
                if fixedTarget == nil {
                    PhrenSingleSelect(options: targetOptions, selection: $selectedTarget,
                                      placeholder: "Project", identifier: "add-task-project",
                                      isPresented: $showingTarget)
                }
            }
            .navigationTitle("Add to Backlog")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        submit()
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || resolvedTarget() == nil)
                }
            }
        }
        .phrenSingleSelectSheet(isPresented: $showingTarget, title: "Project", options: targetOptions,
                                selection: $selectedTarget, rowPrefix: "add-task-project")
    }

    private var targetOptions: [PhrenOption<Target?>] {
        [PhrenOption(id: "none", value: Target?.none, title: "Choose…")]
            + targets.map { PhrenOption(id: $0.id, value: Target?.some($0), title: targetLabel($0)) }
    }

    private func resolvedTarget() -> (storeId: String, project: String)? {
        if let fixedTarget { return fixedTarget }
        guard let selectedTarget else { return nil }
        return (selectedTarget.storeId, selectedTarget.project)
    }

    private func submit() {
        guard let target = resolvedTarget() else { return }
        let value = text
        Task {
            await model.perform(.addTask(project: target.project, text: value), in: target.storeId)
        }
    }
}
