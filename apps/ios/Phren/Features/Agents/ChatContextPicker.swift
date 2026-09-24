import PhrenKit
import SwiftUI

struct ChatContextPicker: View {
    let project: SessionProject
    let insert: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    Text("Add context to your draft, then review it before sending.")
                        .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                }
                if let summary = model.summary(storeId: project.storeID, project: project.name), !summary.isEmpty {
                    Section("Project") {
                        Button("Add project summary", systemImage: "doc.text") { add("Project summary", summary) }
                    }
                }
                Section("Findings") {
                    ForEach(model.findings(storeId: project.storeID, project: project.name).prefix(30)) { finding in
                        Button { add("Finding", finding.text) } label: {
                            Text(finding.text).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain)
                    }
                }
                Section("Skills") {
                    ForEach(model.skills(in: project.storeID).filter { $0.scope == .global || $0.scope.source == project.name }) { skill in
                        Button { add("Skill: \(skill.name)", skill.content) } label: {
                            Label(skill.title ?? skill.name, systemImage: "wand.and.stars")
                        }
                    }
                }
            }
            .navigationTitle("Project context").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
    private func add(_ title: String, _ text: String) {
        insert("\(title) — \(project.name) (\(project.storeID))\n\(text.prefix(8_000))")
        dismiss()
    }
}
