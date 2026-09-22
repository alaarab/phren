import PhrenKit
import PhrenLive
import SwiftUI

/// The `/model` choice as a sheet: one loading row until the computer's
/// catalogue answers (never another harness's list), then phren's
/// single-select card with that list, the models this phone used for the
/// harness recently first (a remembered id the catalogue dropped still leads
/// as its own row) and the default marked with a chip. The built-in
/// per-harness names stand in only when there is no computer to ask or the
/// route fails or answers empty, each row marked "built-in" beside its
/// default chip, and a field for any other id sits at the bottom. Choosing
/// (row or typed id) records the recents and sends `/model <id>`.
struct ChatModelPickerSheet: View {
    static let recentKey = "chat.model.recent.v1"
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
    @State private var failed = false

    private var choices: [AgentModelChoice] {
        if let reported { return reported }
        return isLoading ? [] : AgentModelChoice.choices(source: source)
    }
    /// The computer is being asked whenever one exists (the task starts the
    /// request the moment the sheet opens); only a failed or empty answer or
    /// no host falls back to the built-in list.
    private var isLoading: Bool {
        guard reported == nil, !failed else { return false }
        if host != nil { return true }
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { return true }
        #endif
        return false
    }
    /// The built-in fallback is on screen: each of its rows is marked so.
    private var isFallback: Bool { reported == nil && !isLoading }
    private var customArgument: String? {
        let token = custom.trimmingCharacters(in: .whitespacesAndNewlines)
        return AgentModelChoice.command(for: token) == nil ? nil : token
    }
    private var orderedChoices: [AgentModelChoice] {
        AgentModelRecents.ordered(choices, recent: recentIds).filter { AgentModelChoice.command(for: $0.argument) != nil }
    }
    private var options: [PhrenOption<String>] {
        orderedChoices.map { choice in
            PhrenOption(id: choice.argument, value: choice.argument, title: choice.name,
                        caption: choice.description, trailing: trailingChip(choice))
        }
    }
    /// The row the card checks: the session's reported model matched to at
    /// most one choice (exact id first, so the 1M variant keeps its own mark),
    /// recomputed as the computer's report arrives. The card owns the write;
    /// choosing a row sends through `onSelect`.
    private var currentSelection: Binding<String> {
        Binding(get: { AgentModelChoice.markedChoice(current: current, in: orderedChoices)?.argument ?? "__none__" }, set: { _ in })
    }
    /// `default` for the catalogue's default; in the fallback both chips can
    /// share the slot, so the built-in default stays identifiable.
    private func trailingChip(_ choice: AgentModelChoice) -> AnyView? {
        guard isFallback else { return choice.isDefault ? AnyView(PhrenChip(text: "default")) : nil }
        return AnyView(HStack(spacing: PhrenTheme.Space.xs) {
            if choice.isDefault { PhrenChip(text: "default") }
            PhrenChip(text: "built-in")
        })
    }

    var body: some View {
        PhrenSingleSelectSheet(title: "Model", options: options, selection: currentSelection,
                               rowPrefix: "model-option", loading: isLoading,
                               loadingLabel: host.map { "Loading models from \($0.name)" } ?? "Loading models from the computer",
                               loadingIdentifier: "model-loading",
                               footer: AnyView(customField),
                               onSelect: { argument in commit(argument) },
                               dismiss: { dismiss() })
        .presentationDetents([.medium, .large])
        .task { await loadFromComputer() }
    }

    private var customField: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            TextField("model id", text: $custom)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, PhrenTheme.Space.medium)
                .frame(minHeight: 44)
                .background(PhrenTheme.surfaceRaised,
                            in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
                .accessibilityIdentifier("chat-model-custom")
                .onSubmit { if let token = customArgument { commit(token) } }
            Button("Use") { if let token = customArgument { commit(token) } }
                .font(PhrenTypography.body.weight(.medium))
                .foregroundStyle(PhrenTheme.accent)
                .frame(minWidth: 44, minHeight: 44)
                .disabled(customArgument == nil)
                .accessibilityIdentifier("chat-model-use-custom")
        }
    }

    private func loadFromComputer() async {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            if AgentChatFixture.modelsFailed { failed = true; return }
            if AgentChatFixture.modelsDelayed { try? await Task.sleep(for: .seconds(1.5)) }
            accept(AgentChatFixture.models(source: source))
            return
        }
        #endif
        guard let host else { failed = true; return }
        do {
            accept(try await PhrenConnection.models(host: host, privateKey: try DeviceSSHKey.load(host.id), source: source))
        } catch {
            failed = true
        }
    }

    /// An empty catalogue and a failed route are the same answer: the
    /// built-in list, marked. The fixture and the live path share this.
    private func accept(_ models: [AgentModelChoice]) {
        if models.isEmpty { failed = true } else { reported = models }
    }

    private var recentIds: [String] { recents.ids(source: source) }
    private var recents: AgentModelRecents {
        AgentModelRecents(raw: AppRuntime.defaults.string(forKey: Self.recentKey) ?? "")
    }

    /// A chosen model, typed or tapped, leads the list next time: remember
    /// first, then send the command form.
    private func commit(_ argument: String) {
        guard let command = AgentModelChoice.command(for: argument) else { return }
        var store = recents
        store.remember(argument, source: source)
        AppRuntime.defaults.set(store.raw, forKey: Self.recentKey)
        choose(command)
    }
}
