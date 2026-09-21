import PhrenKit
import PhrenLive
import SwiftUI

/// The `/model` choice as a sheet: phren's single-select card with the agent's
/// usual names, the current one checked, and a field for any other id at the
/// bottom. Choosing sends `/model <id>`.
struct ChatModelPickerSheet: View {
    let source: String
    let current: String?
    var host: LiveHost? = nil
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var custom = ""
    /// What the computer reports. Until it answers the list is empty with a
    /// loading row; the built-in names only stand in when there is no computer
    /// to ask or the request fails, so a wrong list never flashes first.
    @State private var reported: [AgentModelChoice]?
    @State private var loading = false
    @State private var failed = false

    private var choices: [AgentModelChoice] {
        if let reported { return reported }
        return host == nil || failed ? AgentModelChoice.choices(source: source) : []
    }
    private var customCommand: String? { AgentModelChoice.command(for: custom) }
    private var options: [PhrenOption<String>] {
        choices.map { choice in
            PhrenOption(id: choice.argument, value: choice.argument, title: choice.name,
                        caption: choice.description,
                        trailing: choice.isDefault ? AnyView(PhrenChip(text: "default")) : nil)
        }
    }
    private var isLoading: Bool { loading && reported == nil }
    /// The row the card checks: the current model, matched loosely, recomputed
    /// as the computer's report arrives. The card owns the write; choosing a
    /// row sends through `onSelect` instead.
    private var currentSelection: Binding<String> {
        Binding(get: { choices.first(where: isCurrent)?.argument ?? "__none__" }, set: { _ in })
    }

    var body: some View {
        PhrenSingleSelectSheet(title: "Model", options: options, selection: currentSelection,
                               rowPrefix: "chat-model", loading: isLoading,
                               loadingLabel: "Asking the computer…", footer: AnyView(customField),
                               onSelect: { argument in choose("/model " + argument) },
                               dismiss: { dismiss() })
        .presentationDetents([.medium, .large])
        .task { await loadFromComputer() }
    }

    private var customField: some View {
        HStack(spacing: 8) {
            TextField("model id", text: $custom)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, PhrenTheme.Space.medium)
                .frame(minHeight: 44)
                .background(PhrenTheme.surfaceRaised,
                            in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
                .accessibilityIdentifier("chat-model-custom")
                .onSubmit { if let customCommand { choose(customCommand) } }
            Button("Use") { if let customCommand { choose(customCommand) } }
                .font(PhrenTypography.body.weight(.medium))
                .foregroundStyle(PhrenTheme.accent)
                .frame(minWidth: 44, minHeight: 44)
                .disabled(customCommand == nil)
                .accessibilityIdentifier("chat-model-use-custom")
        }
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
        } else {
            failed = true
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
