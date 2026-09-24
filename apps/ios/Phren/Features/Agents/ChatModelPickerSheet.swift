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
/// default chip, and a field for any other id sits at the bottom.
///
/// For Claude and Codex a model row does not switch on its own: it becomes
/// the chosen model and its effort levels appear under it (the catalogue's
/// own levels, low/medium/high when the harness reports none, the current
/// effort checked when known). Choosing a level asks the Hook to switch and
/// verify the model with that effort. A typed id switches without one.
struct ChatModelPickerSheet: View {
    static let recentKey = "chat.model.recent.v1"
    /// The harnesses whose model switch also sets an effort.
    static let effortSources: Set<String> = ["claude", "codex"]
    static let fallbackEfforts = ["low", "medium", "high"]
    let source: String
    let current: String?
    var currentEffort: String? = nil
    var host: LiveHost? = nil
    let choose: (String, String?) async throws -> Void
    let deferChoice: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var custom = ""
    /// What the computer reports. Until it answers the list is empty with a
    /// loading row; the built-in names only stand in when there is no computer
    /// to ask or the request fails, so a wrong list never flashes first.
    @State private var reported: [AgentModelChoice]?
    @State private var failed = false
    @State private var switching = false
    @State private var switchError: String?
    @State private var waitingChoice: (argument: String, effort: String?)?
    /// The model row tapped, whose effort levels show under it. Nil keeps
    /// the session's own model chosen.
    @State private var chosenModel: String?

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
    private var takesEffort: Bool { Self.effortSources.contains(source) }
    private var customArgument: String? {
        let token = custom.trimmingCharacters(in: .whitespacesAndNewlines)
        return AgentModelChoice.command(for: token) == nil ? nil : token
    }
    private var orderedChoices: [AgentModelChoice] {
        AgentModelRecents.ordered(choices, recent: recentIds).filter { AgentModelChoice.command(for: $0.argument) != nil }
    }
    private var options: [PhrenOption<String>] {
        guard waitingChoice == nil else { return [] }
        return orderedChoices.map { choice in
            PhrenOption(id: choice.argument, value: choice.argument, title: choice.name,
                        caption: choice.description, trailing: trailingChip(choice))
        }
    }
    /// The session's reported model matched to at most one choice (exact id
    /// first, so the 1M variant keeps its own mark), recomputed as the
    /// computer's report arrives.
    private var markedCurrent: String? {
        AgentModelChoice.markedChoice(current: current, in: orderedChoices)?.argument
    }
    /// The row the card checks: the tapped model, else the session's own.
    /// The card owns the write; choosing a row goes through `onSelect`.
    private var currentSelection: Binding<String> {
        Binding(get: { chosenModel ?? markedCurrent ?? "__none__" }, set: { _ in })
    }
    /// `default` for the catalogue's default; in the fallback both chips can
    /// share the slot, so the built-in default stays identifiable. `current`
    /// keeps the session's model identifiable once another row is chosen.
    private func trailingChip(_ choice: AgentModelChoice) -> AnyView? {
        var chips: [String] = []
        if choice.isDefault { chips.append("default") }
        if isFallback { chips.append("built-in") }
        if let chosenModel, chosenModel != choice.argument, choice.argument == markedCurrent { chips.append("current") }
        guard !chips.isEmpty else { return nil }
        return AnyView(HStack(spacing: PhrenTheme.Space.xs) {
            ForEach(chips, id: \.self) { PhrenChip(text: $0) }
        })
    }

    /// The chosen model's own effort levels, else the three every harness takes.
    static func efforts(for choice: AgentModelChoice?) -> [String] {
        guard let listed = choice?.efforts, !listed.isEmpty else { return fallbackEfforts }
        return listed
    }

    static func effortTitle(_ level: String) -> String {
        PhrenConnection.LaunchEffort(rawValue: level)?.title ?? level.capitalized
    }

    var body: some View {
        PhrenSingleSelectSheet(title: "Model", options: options, selection: currentSelection,
                               rowPrefix: "model-option", loading: isLoading,
                               loadingLabel: host.map { "Loading models from \($0.name)" } ?? "Loading models from the computer",
                               loadingIdentifier: "model-loading",
                               footer: AnyView(switchFooter),
                               below: { argument in effortRows(under: argument) },
                               onSelect: { argument in
                                   if takesEffort { chosenModel = argument; switchError = nil } else { commit(argument, effort: nil) }
                               },
                               dismissOnSelect: false,
                               dismiss: { dismiss() })
        .disabled(switching)
        .interactiveDismissDisabled(switching)
        .presentationDetents([.medium, .large])
        .task { await loadFromComputer() }
    }

    /// Effort levels under the chosen model, indented to its title. The
    /// current effort is checked when this phone knows it; the catalogue's
    /// default carries its chip. A level switches the model with it.
    private func effortRows(under argument: String) -> AnyView? {
        guard takesEffort, waitingChoice == nil, argument == (chosenModel ?? markedCurrent) else { return nil }
        let choice = orderedChoices.first { $0.argument == argument }
        let levels = Self.efforts(for: choice)
        return AnyView(VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            Text("Effort")
                .font(PhrenTypography.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                .accessibilityAddTraits(.isHeader)
            ForEach(levels, id: \.self) { level in
                PhrenOptionRow(title: Self.effortTitle(level), selected: level == currentEffort,
                               trailing: level == choice?.defaultEffort ? AnyView(PhrenChip(text: "default")) : nil) {
                    commit(argument, effort: level)
                }
                .phrenIdentifier("model-effort:\(level)")
            }
        }
        .padding(.leading, 32)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Effort for \(choice?.name ?? argument)"))
    }

    private var customField: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            PhrenTextField("model id", text: $custom, identifier: "chat-model-custom", monospaced: true)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .onSubmit { if let token = customArgument { commit(token, effort: nil) } }
            Button("Use") { if let token = customArgument { commit(token, effort: nil) } }
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

    private var switchFooter: some View {
        VStack(spacing: PhrenTheme.Space.small) {
            if switching {
                Text("Switching model…").font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            if let switchError {
                Text(switchError).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityIdentifier("chat-model-error")
            }
            if let waiting = waitingChoice {
                PhrenOptionRow(title: "Switch after this turn", icon: "clock") {
                    remember(waiting.argument)
                    deferChoice(waiting.argument, waiting.effort)
                    dismiss()
                }
                .phrenIdentifier("chat-model-after-turn")
                PhrenOptionRow(title: "Cancel", icon: "xmark") {
                    waitingChoice = nil; switchError = nil
                }
                .phrenIdentifier("chat-model-cancel-switch")
            } else {
                customField
            }
        }
    }

    private func remember(_ argument: String) {
        var store = recents
        store.remember(argument, source: source)
        AppRuntime.defaults.set(store.raw, forKey: Self.recentKey)
    }

    private func commit(_ argument: String, effort: String?) {
        guard !switching, AgentModelChoice.command(for: argument) != nil else { return }
        switching = true; waitingChoice = nil; switchError = nil
        Task {
            defer { switching = false }
            do {
                try await choose(argument, effort)
                remember(argument)
                dismiss()
            } catch AgentModelSwitchError.working {
                switchError = "This agent is working. The model can switch when the turn ends."
                waitingChoice = (argument, effort)
            } catch {
                switchError = error.localizedDescription
            }
        }
    }
}
