import PhrenKit
import PhrenLive
import SwiftUI
import UIKit

/// What the composer's primary button is for right now. Shared by the bar,
/// which draws it, and the chat, which acts on it.
struct ChatComposerMode {
    let showsStop: Bool
    /// Pending means the harness cannot currently receive input.
    let showsQueue: Bool
    let primaryActionEnabled: Bool

    @MainActor init(model: AgentChatModel, active: Bool) {
        let hasDraft = !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty
        let stop = model.target?.isStarting != true && model.isBusy
            && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.attachments.isEmpty
        showsStop = stop
        showsQueue = model.target != nil && model.pendingReason != nil && !stop && hasDraft
        let canSend = active && model.target != nil && !model.sending && !model.stopping && !model.answering && hasDraft
        primaryActionEnabled = stop
            ? active && model.connected && !model.sending && !model.stopping && !model.answering
            : canSend
    }
}

/// What the composer asks the chat screen to do. The chat owns the sheets,
/// the send task and the scroll that follows a send.
struct ChatComposerActions {
    /// Runs one agent request as the chat's cancellable send task.
    let run: (@escaping @MainActor () async -> Void) -> Void
    let preview: (ChatAttachmentDraft) -> Void
    let addAttachment: () -> Void
    let switchAgent: () -> Void
    let showChildAgents: () -> Void
    let enterSecret: () -> Void
    let toggleDictation: () -> Void
    let primary: () -> Void
    let openCommandMenu: () -> Void
    let pasteImages: ([NSItemProvider]) -> Void
}

/// Opens the pane's terminal from an answer card.
struct ChatAnswerTerminalLink: View {
    let session: LiveAgentSession
    let target: AgentChatTarget?

    var body: some View {
        NavigationLink { HerdrTerminalView(host: session.host, session: session, target: target) } label: {
            Label("Terminal", systemImage: "terminal")
                .font(PhrenTheme.Font.caption)
                .foregroundStyle(PhrenTheme.textMuted)
        }
        .accessibilityIdentifier("chat-answer-terminal")
    }
}

/// The bottom of the chat: attachments, slash commands, terminal answers,
/// delivery errors, the message field and its button row.
struct ChatComposerBar: View {
    @Bindable var model: AgentChatModel
    let session: LiveAgentSession
    let active: Bool
    @Binding var composing: Bool
    let dictation: ChatDictationController
    let textSelection: ChatTextSelection
    let childAgentsError: String?
    let runningChildAgentCount: Int
    let actions: ChatComposerActions
    @Binding var attachmentMenu: Bool
    let attachmentMenuItems: [PhrenMenuItem]
    /// The fallback key strip stays collapsed behind the Keys chip.
    @State private var answerKeysExpanded = false
    @ScaledMetric(relativeTo: .body) private var composerTextSize = 14.0

    private var dictating: Bool { dictation.isRecording }
    private var answerTerminalLink: ChatAnswerTerminalLink { ChatAnswerTerminalLink(session: session, target: model.target) }

    var body: some View {
        let mode = ChatComposerMode(model: model, active: active)
        VStack(alignment: .leading, spacing: 6) {
            if !model.attachments.isEmpty { attachments }

            if composing, AgentSlashCommand.isCommand(model.draft) {
                SlashCommandMenu(source: model.target?.source ?? "", draft: model.draft,
                                 choose: { model.draft = $0 + " " }, openAll: actions.openCommandMenu)
            }
            if model.needsAnswer && model.approval == nil && (model.question == nil || model.terminalPrompt?.questionPrompt != nil) {
                terminalAnswer
            }
            if model.needsAnswer, model.approval == nil, model.passwordPrompt { passwordPrompt }
            if let error = model.deliveryError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-delivery-error") }
            if let error = model.draftStorageError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-draft-storage-error") }
            if let error = model.statusError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-status-error") }
            if let error = childAgentsError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-subagents-error") }
            VStack(spacing: 0) {
                messageField
                buttonRow(mode)
            }
            .padding(.top, 2)
            .background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(PhrenTheme.border, lineWidth: 0.5) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-message-box")
            .disabled(model.restoringDraft)
        }
        .buttonStyle(.plain).foregroundStyle(PhrenTheme.chatText)
        .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, PhrenDensity.composerBottom)
        .background(PhrenTheme.chatCanvas.ignoresSafeArea(.container, edges: .bottom))
    }

    private var attachments: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(model.attachments) { item in
                    VStack(spacing: 4) {
                        HStack(spacing: 6) {
                            Button { if item.attachment.isImage { actions.preview(item) } } label: {
                                if item.attachment.isImage {
                                    ChatAttachmentImage(attachment: item.attachment, maximumPixels: 168).frame(width: 56, height: 56).clipped().clipShape(RoundedRectangle(cornerRadius: 10))
                                } else { Image(systemName: "doc").frame(width: 56, height: 56) }
                            }.accessibilityLabel("Preview \(item.attachment.name)")
                            Button {
                                model.attachments.removeAll { $0.id == item.id }
                            } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 20)).frame(width: 44, height: 44) }
                                .disabled(model.sending).accessibilityLabel("Remove \(item.attachment.name)")
                        }
                        Text(item.attachment.name).font(.caption).lineLimit(1).frame(maxWidth: 120)
                    }.padding(8).background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }.accessibilityIdentifier("chat-attachments")
    }

    @ViewBuilder private var terminalAnswer: some View {
        if let prompt = model.terminalPrompt {
            if let questions = prompt.questionPrompt {
                // A released AskUserQuestion: the same card a held
                // question draws, answered with each option's digit
                // through the keys route.
                ChatQuestionCard(prompt: questions, busy: model.answering || !active || !model.connected,
                                 title: "\(model.target?.providerName ?? "Agent") asks",
                                 headerAccessory: AnyView(terminalAnswerCaption)) { answers in
                    actions.run { await model.answerTerminalQuestions(session, answers: answers) }
                }
                .id(prompt.message ?? "terminal-questions")
            } else if let choice = prompt.choice, choice.prompt(id: "terminal-choice") != nil {
                // The terminal dialog the Hook read: the actual question
                // and its options, answered by their own keys. No key
                // strip and no waiting line behind it. Codex's queued
                // follow-up question opens with alt+up first.
                ChatChoiceQuestionCard(choice: choice, id: "terminal-choice", title: "\(model.target?.providerName ?? "Agent") asks",
                                       busy: model.answering || !active || !model.connected,
                                       terminal: AnyView(answerTerminalLink)) { key in
                    let keys: [AgentAnswerKey] = prompt.queued ? [.altUp, key] : [key]
                    actions.run { await model.answer(session, keys: keys) }
                }
                .id(prompt.message ?? "terminal-choice")
            } else {
                ChatTerminalQuestionCard(providerName: model.target?.providerName ?? "Agent", prompt: prompt,
                                         answering: model.answering,
                                         disabled: model.answering || !active || !model.connected,
                                         terminal: { answerTerminalLink }) { key in
                    actions.run { await model.answer(session, key: key) }
                }
            }
        } else {
            // Nothing parsed: one row with the terminal and a Keys
            // disclosure, whose strip is hidden until asked for.
            VStack(alignment: .leading, spacing: 8) {
                Text("Waiting for your answer")
                    .font(PhrenTheme.Font.caption)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(1)
                HStack(spacing: 10) {
                    NavigationLink { HerdrTerminalView(host: session.host, session: session, target: model.target) } label: {
                        Label("Open terminal", systemImage: "terminal")
                            .font(PhrenTheme.Font.caption)
                            .foregroundStyle(PhrenTheme.textMuted)
                    }
                    .accessibilityIdentifier("chat-answer-terminal")
                    Spacer(minLength: 4)
                    Button { answerKeysExpanded.toggle() } label: {
                        PhrenChip(text: answerKeysExpanded ? "Hide keys" : "Keys", icon: "keyboard")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(answerKeysExpanded ? "Hide answer keys" : "Show answer keys")
                    .accessibilityIdentifier("chat-answer-keys-toggle")
                }
                if answerKeysExpanded {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            // Letters answer Claude's own dialogs; in a
                            // Codex composer they would only type text.
                            ForEach(quietAnswerKeys) { key in
                                Button { actions.run { await model.answer(session, key: key) } } label: {
                                    Text(key.label)
                                        .font(PhrenTheme.Font.monoFootnote.weight(.semibold))
                                        .foregroundStyle(PhrenTheme.textMuted)
                                        .frame(minWidth: 48, minHeight: 36)
                                        .contentShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous)
                                            .strokeBorder(PhrenTheme.border, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                                .disabled(model.answering || !active || !model.connected)
                                .accessibilityLabel(key.spoken)
                                .accessibilityIdentifier("chat-answer-key:\(key.rawValue)")
                            }
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-answer-keys")
        }
    }

    /// Only a pane really reading a password offers the secret sheet.
    private var passwordPrompt: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.fill").font(.system(size: 13)).foregroundStyle(PhrenTheme.warning)
            Text("The terminal is asking for a password")
                .font(PhrenTheme.Font.caption)
                .foregroundStyle(PhrenTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: actions.enterSecret) {
                Label("Enter password", systemImage: "key.fill")
                    .font(PhrenTheme.Font.caption.weight(.semibold))
                    .frame(minHeight: 32)
            }
            .buttonStyle(.plain)
            .foregroundStyle(PhrenTheme.cyan)
            .disabled(model.answering || !active || !model.connected)
            .accessibilityIdentifier("chat-answer-secret")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-password-prompt")
    }

    private var messageField: some View {
        ChatComposer(text: $model.draft, focused: Binding(get: { composing }, set: { composing = $0 }),
                     placeholder: "Message \(model.target?.providerName ?? "agent")…",
                     size: composerTextSize, selection: textSelection,
                     pasteImages: actions.pasteImages)
            .overlay(alignment: .topLeading) {
                if model.draft.isEmpty {
                    Text("Message \(model.target?.providerName ?? "agent")…")
                        .font(.system(size: composerTextSize, design: .monospaced))
                        .foregroundStyle(PhrenTheme.textMuted)
                        .padding(.horizontal, 12)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .contentShape(Rectangle())
            // The padding around the editor still focuses it.
            .simultaneousGesture(TapGesture().onEnded { if !composing { composing = true } })
            .dismissKeyboardOnDownwardDrag {
                guard !textSelection.preventsKeyboardDismissal,
                      textSelection.composerView?.hasScrollableDraft != true else { return }
                composing = false
            }
            .accessibilityIdentifier("chat-composer").disabled(model.target == nil)
    }

    private func buttonRow(_ mode: ChatComposerMode) -> some View {
        HStack(alignment: .bottom, spacing: 4) {
            Button(action: actions.addAttachment) {
                Image(systemName: "plus").font(.system(size: 17, weight: .light)).frame(width: 40, height: 40)
                    .contentShape(Rectangle().inset(by: -2))
            }.accessibilityLabel("Add attachment").disabled(model.target == nil || model.sending)
                .phrenAnchoredMenu(isPresented: $attachmentMenu, items: attachmentMenuItems, identifier: "chat-attach-menu")
            NavigationLink {
                HerdrTerminalView(host: session.host, session: session, target: model.target)
            } label: {
                Image(systemName: "terminal").font(.system(size: 17)).frame(width: 40, height: 40)
                    .contentShape(Rectangle().inset(by: -2))
            }.accessibilityLabel("Open Herdr terminal").accessibilityIdentifier("chat-composer-terminal")
            Button { composing = false; actions.switchAgent() } label: {
                Image(systemName: "person.2")
                    .font(.system(size: 17)).frame(width: 40, height: 40)
                    .contentShape(Rectangle().inset(by: -2))
            }.accessibilityLabel("Switch agent").accessibilityIdentifier("chat-switch-agent")
                .disabled(model.sending || model.answering || model.stopping)
            if runningChildAgentCount > 0 {
                Button(action: actions.showChildAgents) {
                    Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                        .font(.system(size: 17)).frame(width: 40, height: 40)
                        .contentShape(Rectangle().inset(by: -2))
                        .foregroundStyle(PhrenTheme.chatText)
                        .overlay(alignment: .topTrailing) {
                            Text("\(runningChildAgentCount)")
                                .font(.system(.caption2, design: .monospaced).weight(.bold)).monospacedDigit()
                                .foregroundStyle(PhrenTheme.phrenCardAccent)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(PhrenTheme.chatPanel, in: Capsule())
                        }
                }
                .accessibilityLabel("\(runningChildAgentCount) running \(runningChildAgentCount == 1 ? "agent" : "agents")")
                .accessibilityIdentifier("chat-agent-tree")
            }
            Spacer(minLength: 4)
            Button(action: actions.toggleDictation) {
                Image(systemName: dictating ? "mic.fill" : "mic").font(.system(size: 17))
                    .foregroundStyle(dictating ? PhrenTheme.accent : PhrenTheme.chatText)
                    .scaleEffect(dictating ? 1 + CGFloat(dictation.audioLevel) * 0.25 : 1)
                    .animation(.easeOut(duration: 0.12), value: dictation.audioLevel)
                    .frame(width: 40, height: 40).contentShape(Rectangle().inset(by: -2))
            }.accessibilityLabel(dictating ? "Stop dictation" : "Dictate message")
                .accessibilityIdentifier("chat-dictate")
                .disabled(model.target == nil || model.sending)
            Button(action: actions.primary) {
                Group {
                    if model.sending || model.stopping { ProgressView().tint(PhrenTheme.chatPanel) }
                    else { Image(systemName: mode.showsStop ? "stop.fill" : mode.showsQueue ? "text.append" : "arrow.up").font(.system(size: mode.showsStop ? 13 : mode.showsQueue ? 17 : 19, weight: .semibold)) }
                }
                .frame(width: 36, height: 36)
                .foregroundStyle(mode.primaryActionEnabled ? PhrenTheme.chatPanel : PhrenTheme.textDim)
                .background(mode.primaryActionEnabled ? PhrenTheme.cyan : PhrenTheme.borderStrong, in: Circle())
                .frame(width: 40, height: 40).contentShape(Rectangle().inset(by: -2))
            }
            .disabled(!mode.primaryActionEnabled)
            .accessibilityLabel(mode.showsStop ? "Stop" : mode.showsQueue ? "Keep pending" : "Send message")
            .accessibilityIdentifier(mode.showsStop ? "chat-stop" : mode.showsQueue ? "chat-queue" : "chat-send")
            .accessibilityValue(model.deliveryStatus ?? "")
            .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(.horizontal, 6).padding(.bottom, 4)
        .contentShape(Rectangle())
        .dismissKeyboardOnDownwardDrag {
            guard !textSelection.preventsKeyboardDismissal else { return }
            composing = false
        }
    }

    /// A released question is answered in the agent's own terminal, so the
    /// card says so rather than promising an approval-style reply.
    private var terminalAnswerCaption: some View {
        Text("answered in the terminal")
            .font(PhrenTheme.Font.caption2)
            .foregroundStyle(PhrenTheme.textMuted)
            .lineLimit(1)
            .accessibilityIdentifier("chat-terminal-answer-caption")
    }

    private var quietAnswerKeys: [AgentAnswerKey] {
        [.enter, .up, .down, .tab, .escape, .yes, .no].filter { key in
            ![.yes, .no].contains(key) || model.terminalPrompt != nil || model.target?.source == "claude"
        }
    }
}
