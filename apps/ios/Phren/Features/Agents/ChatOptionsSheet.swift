import PhrenKit
import PhrenLive
import SwiftUI

/// Only what has no home elsewhere on this screen: the terminal, slash
/// commands, dictation and reconnecting live in the composer or the
/// connection notice. The header keeps only its title, so grants,
/// repository changes and project linking are here. A sheet, not a
/// menu: the header's menu never opened on the phone.
struct ChatOptionsSheet: View {
    /// What a row asks the chat to do once this sheet has closed.
    enum Action {
        case showChanges, linkProject, chooseAnother, pickModel, showUsage, addContext
    }

    let session: LiveAgentSession
    let model: AgentChatModel
    let project: SessionProject?
    let indexedCode: SessionCodeContext?
    /// The store the conductor's grants belong to when no project is linked.
    let fallbackStoreID: String?
    @Binding var isPresented: Bool
    let perform: (Action) -> Void

    /// Repository changes, when the pane allows them. Not for the conductor:
    /// its tree is the phren store, which the changes screen has no use for.
    private var canShowChanges: Bool {
        !session.tab.isConductor && model.target != nil
            && ((model.capabilities ?? session.capabilities)?.allows(.changes) ?? true)
    }

    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    NavigationLink { HerdrWorkspacesView(hostID: session.host.id) } label: { Label("Herdr workspaces", systemImage: "rectangle.split.3x1") }
                    if session.tab.isConductor {
                        NavigationLink {
                            ConductorGrantsView(host: session.host, storeId: project?.storeID ?? fallbackStoreID)
                        } label: { Label("Grants", systemImage: "checkmark.seal") }
                        .accessibilityIdentifier("chat-options-grants")
                    }
                    if canShowChanges {
                        // Pushed on the chat's own stack at full height, as
                        // it was from the header.
                        Button { afterOptions(.showChanges) } label: {
                            Label("Repository changes", systemImage: "arrow.triangle.branch")
                        }
                        .accessibilityIdentifier("chat-diff")
                    }
                    if let target = model.target {
                        // This session's own servers only; the computer's
                        // whole list stays on the computer's page.
                        NavigationLink { SessionWebServersView(session: session, target: target) } label: {
                            Label("Web servers", systemImage: "globe")
                        }
                        .accessibilityIdentifier("chat-options-web-servers")
                    }
                    if !session.tab.isConductor, project == nil, session.tab.cwd != nil {
                        Button { afterOptions(.linkProject) } label: { Label("Link to project", systemImage: "link") }
                            .accessibilityIdentifier("chat-link-project")
                    }
                    if model.panes.filter({ (try? $0.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil }).count > 1 {
                        Button { afterOptions(.chooseAnother) } label: { Label("Choose another agent", systemImage: "person.2") }
                            .disabled(model.sending)
                    }
                    if AgentModelChoice.supportsPicker(source: model.target?.source ?? "") {
                        Button { afterOptions(.pickModel) } label: {
                            Label(model.modelName.map { "Model · \($0)" } ?? "Model", systemImage: "cpu")
                        }
                        .disabled(model.sending || model.target == nil)
                        .accessibilityIdentifier("chat-options-model")
                    }
                }
                if model.progress.usage != nil || model.progressUnavailable {
                    // Above the project rows: the medium sheet's fold would
                    // otherwise hide the conversation's own section.
                    Section("This conversation") { tokenUsage }
                }
                if let project {
                    Section("Project") {
                        if let origin = indexedCode {
                            NavigationLink {
                                CodeView(storeId: origin.storeID, project: origin.project, origin: origin)
                            } label: { Label("Code", systemImage: "curlybraces") }
                            .accessibilityIdentifier("chat-options-code")
                        }
                        NavigationLink { ProjectDetailView(storeId: project.storeID, project: project.name) } label: { Label("Project memory", systemImage: "brain.head.profile") }
                        NavigationLink { SkillsView(project: project.name, storeId: project.storeID) } label: { Label("Project skills", systemImage: "sparkles") }
                        NavigationLink { GraphView(focusProject: project.name, initialStoreId: project.storeID) } label: { Label("Explore graph", systemImage: "point.3.connected.trianglepath.dotted") }
                        Button { afterOptions(.addContext) } label: { Label("Add project context", systemImage: "brain") }
                    }
                }
            }
            .navigationTitle("Chat options").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { isPresented = false }.accessibilityIdentifier("chat-options-done") } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    /// Close the options sheet, then present or act; two sheets cannot
    /// change places in the same beat.
    private func afterOptions(_ action: Action) {
        isPresented = false
        Task { try? await Task.sleep(for: .milliseconds(350)); perform(action) }
    }

    @ViewBuilder private var tokenUsage: some View {
        if let usage = model.progress.usage {
            Button { afterOptions(.showUsage) } label: {
                Label("Token usage", systemImage: "chart.bar")
            }.accessibilityIdentifier("chat-token-usage").accessibilityLabel("Latest reported usage: \(usage.output) output tokens, \(usage.input) input tokens")
        } else if model.progressUnavailable {
            Link(destination: URL(string: "https://github.com/alaarab/phren/blob/main/apps/ios/README.md#live-token-counts")!) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Tokens unavailable")
                        Text("Set up token counts on this computer").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                } icon: { Image(systemName: "chart.bar") }
            }
        }
    }
}

/// Token counts for the latest model response.
struct ChatUsageSheet: View {
    let model: AgentChatModel
    let done: () -> Void

    var body: some View {
        if let usage = model.progress.usage {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Latest model response").font(.headline)
                    Spacer()
                    Button("Done", action: done)
                }
                VStack(spacing: 10) {
                    LabeledContent("Total input", value: usage.input.formatted())
                        .accessibilityElement(children: .combine).accessibilityIdentifier("usage-total-input")
                    if let cached = usage.cachedInput, let uncached = usage.uncachedInput {
                        LabeledContent("Reused from cache", value: cached.formatted())
                        LabeledContent("Uncached input", value: uncached.formatted())
                    }
                    Divider()
                    LabeledContent("Output", value: usage.output.formatted())
                        .accessibilityElement(children: .combine).accessibilityIdentifier("usage-output")
                    if let reasoning = usage.reasoningOutput, reasoning > 0 {
                        LabeledContent("Included reasoning", value: reasoning.formatted())
                    }
                }.font(.subheadline).monospacedDigit()
                Text("Input includes conversation context, instructions, and tool results. Cached input is part of that total. These are tokens for one model response, not the whole conversation or your account quota.")
                    .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
            }
            // Pinned to the top: a medium sheet otherwise floats the counts in its middle.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(24).foregroundStyle(PhrenTheme.text)
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            .presentationBackground(PhrenTheme.chatCanvas)
        }
    }
}
