import PhrenKit
import PhrenLive
import SwiftUI

struct LiveProjectPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.liveSessionPreferences) private var livePreferences
    @State private var error: String?
    let hostID: UUID
    let cwd: String
    let existing: LiveSessionPreferences.Mapping?

    var body: some View {
        PhrenList {
            Section {
                Text(cwd).font(.caption.monospaced())
                Text("Link this directory and its subdirectories to a project on this iPhone.").foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.orange) }
            }
            ForEach(model.storeDescriptors) { store in
                Section(store.id) {
                    ForEach(model.snapshot(for: store.id).projects.filter { $0.name != "global" }, id: \.name) { project in
                        Button(project.name) { assign(storeID: store.id, project: project.name, directory: cwd) }
                            .accessibilityIdentifier("live-project:\(store.id):\(project.name)")
                    }
                }
            }
            if let existing {
                Button("Remove directory link", role: .destructive) {
                    assign(storeID: nil, project: nil, directory: existing.directory)
                }
            }
        }
        .navigationTitle("Link project")
        .toolbar { Button("Cancel") { dismiss() } }
        .phrenScreen()
    }
    private func assign(storeID: String?, project: String?, directory: String) {
        do {
            try livePreferences.update {
                try LiveSessionPreferences.assigning(hostID: hostID, directory: directory,
                                                     storeID: storeID, project: project, in: $0)
            }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
