import PhrenKit
import SwiftUI

/// A draft owns the version the user opened, independent of live refreshes.
struct DocumentDraft: Identifiable {
    let id = UUID()
    let path: String
    let content: String?
}

struct DocumentEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let title: String
    let storeId: String
    let draft: DocumentDraft
    let initialText: String
    @State private var text: String
    @State private var expectedContent: String?
    @State private var comparison: DocumentDraft?
    @State private var saving = false
    @State private var error: String?
    @State private var confirmingDiscard = false

    init(title: String, storeId: String, draft: DocumentDraft, template: String = "") {
        self.title = title
        self.storeId = storeId
        self.draft = draft
        initialText = draft.content ?? template
        _text = State(initialValue: draft.content ?? template)
        _expectedContent = State(initialValue: draft.content)
    }

    private var dirty: Bool { text != initialText || expectedContent != draft.content }
    private var latestContent: String? {
        if LocalStore.isSkillPath(draft.path) {
            return model.skills(in: storeId).first { $0.path == draft.path }?.content
        }
        return model.instructions(scope: String(draft.path.split(separator: "/")[0]), in: storeId)
    }
    private var warnings: [String] {
        LocalStore.isSkillPath(draft.path) ? SkillFile.frontmatterWarnings(for: text) : []
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                Text(model.storeName(for: storeId))
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                ForEach(warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange).padding(.horizontal)
                }
                TextEditor(text: $text)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel("Instructions")
                    .disabled(saving)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if dirty { confirmingDiscard = true } else { dismiss() }
                    }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving || (!dirty && draft.content != nil)
                                  || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || !model.canPush(storeId: storeId))
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
            .alert("Couldn't save", isPresented: $error.isPresent()) {
                if latestContent != expectedContent {
                    Button("Compare versions") {
                        comparison = DocumentDraft(path: draft.path, content: latestContent)
                    }
                }
                Button("Keep editing", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
            .sheet(item: $comparison) { latest in
                NavigationStack {
                    PhrenList {
                        Section("Latest in store") {
                            if let content = latest.content { DocumentPreview(content: content) }
                            else { Text("This file was removed from the store.") }
                        }
                        Section {
                            TextEditor(text: $text)
                                .font(.system(.body, design: .monospaced))
                                .frame(minHeight: 240)
                                .accessibilityLabel("Merged draft")
                            ShareLink(item: text) { Label("Share draft", systemImage: "square.and.arrow.up") }
                        } header: { Text("Your draft") } footer: {
                            Text("Include the changes you want to keep. Saving your merged draft will replace the latest version.")
                        }
                    }
                    .navigationTitle("Compare versions")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Use merged draft") {
                                expectedContent = latest.content
                                comparison = nil
                            }
                        }
                    }
                }
            }
        }
        .interactiveDismissDisabled(dirty || saving)
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            try await model.saveDocument(path: draft.path, content: text, expectedContent: expectedContent, in: storeId)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct DocumentPreview: View {
    let content: String

    var body: some View {
        // Preserve paragraphs and code blocks for instruction-heavy documents.
        Text(content)
            .font(.body)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
