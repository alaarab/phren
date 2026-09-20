import PhrenKit
import PhrenLive
import SwiftUI

/// The `/model` choice as a sheet: the agent's usual names, the current one
/// marked, and a field for any other id. Choosing sends `/model <id>`.
struct ChatModelPickerSheet: View {
    let source: String
    let current: String?
    var host: LiveHost? = nil
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var custom = ""
    /// What the computer reports; the built-in names stand in until it answers.
    @State private var reported: [AgentModelChoice]?
    @State private var loading = false

    private var choices: [AgentModelChoice] { reported ?? AgentModelChoice.choices(source: source) }
    private var customCommand: String? { AgentModelChoice.command(for: custom) }

    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    ForEach(choices) { choice in
                        Button { choose("/model " + choice.argument) } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(choice.name).foregroundStyle(PhrenTheme.text)
                                        if choice.isDefault {
                                            Text("default").font(.caption2.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                                                .padding(.horizontal, 5).padding(.vertical, 1)
                                                .background(PhrenTheme.surfaceRaised, in: Capsule())
                                        }
                                    }
                                    Text(choice.argument).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted)
                                    if let description = choice.description {
                                        Text(description).font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(2)
                                    }
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
            .task { await loadFromComputer() }
            .overlay(alignment: .top) { if loading { ProgressView().padding(.top, 8).accessibilityLabel("Loading models") } }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("chat-model-cancel") } }
            .phrenScreen()
        }
        .presentationDetents([.medium, .large])
    }

    private func loadFromComputer() async {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { reported = AgentChatFixture.models(source: source); return }
        #endif
        guard let host else { return }
        loading = true
        defer { loading = false }
        if let models = try? await PhrenConnection.models(host: host, privateKey: try DeviceSSHKey.load(host.id), source: source), !models.isEmpty {
            reported = models
        }
    }

    /// The transcript reports full ids ("claude-sonnet-5"); the choice may be
    /// an alias ("sonnet"). Either direction of containment marks it current.
    private func isCurrent(_ choice: AgentModelChoice) -> Bool {
        guard let current = current?.lowercased(), !current.isEmpty else { return false }
        let argument = choice.argument.lowercased().replacingOccurrences(of: "[1m]", with: "")
        return current == argument || current.contains(argument) || argument.contains(current)
    }
}
