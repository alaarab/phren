import PhrenKit
import SwiftUI

/// The `/model` choice as a sheet: the agent's usual names, the current one
/// marked, and a field for any other id. Choosing sends `/model <id>`.
struct ChatModelPickerSheet: View {
    let source: String
    let current: String?
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var custom = ""

    private var choices: [AgentModelChoice] { AgentModelChoice.choices(source: source) }
    private var customCommand: String? { AgentModelChoice.command(for: custom) }

    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    ForEach(choices) { choice in
                        Button { choose("/model " + choice.argument) } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(choice.name).foregroundStyle(PhrenTheme.text)
                                    Text(choice.argument).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted)
                                }
                                Spacer(minLength: 8)
                                if isCurrent(choice) {
                                    Image(systemName: "checkmark").foregroundStyle(PhrenTheme.accent).accessibilityLabel("Current")
                                }
                            }
                            .frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat-model:\(choice.argument)")
                    }
                }
                Section("Other") {
                    HStack(spacing: 8) {
                        TextField("model id", text: $custom)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                            .accessibilityIdentifier("chat-model-custom")
                            .onSubmit { if let customCommand { choose(customCommand) } }
                        Button("Use") { if let customCommand { choose(customCommand) } }
                            .disabled(customCommand == nil)
                            .accessibilityIdentifier("chat-model-use-custom")
                    }
                }
            }
            .navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("chat-model-cancel") } }
            .phrenScreen()
        }
        .presentationDetents([.medium, .large])
    }

    /// The transcript reports full ids ("claude-sonnet-5"); the choice may be
    /// an alias ("sonnet"). Either direction of containment marks it current.
    private func isCurrent(_ choice: AgentModelChoice) -> Bool {
        guard let current = current?.lowercased(), !current.isEmpty else { return false }
        let argument = choice.argument.lowercased().replacingOccurrences(of: "[1m]", with: "")
        return current == argument || current.contains(argument) || argument.contains(current)
    }
}
