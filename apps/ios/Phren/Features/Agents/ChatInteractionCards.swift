import Foundation
import PhrenKit
import SwiftUI

struct ChatApprovalCard<Terminal: View>: View {
    let approval: AgentApproval
    let busy: Bool
    @ViewBuilder let terminal: () -> Terminal
    let answer: (Bool) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Permission needed", systemImage: "hand.raised").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.warning)
                .accessibilityIdentifier("chat-approval")
            Text(approval.title ?? approval.toolName ?? "Allow this action?").font(.headline).lineLimit(2)
            if let explanation = approval.explanation {
                Text(explanation).font(.subheadline).lineLimit(4).textSelection(.enabled)
            }
            if let message = approval.message, !message.isEmpty {
                DisclosureGroup("Action details") {
                    ScrollView { Text(message).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 220)
                }
            }
            terminal().buttonStyle(.bordered).frame(maxWidth: .infinity)
            if typeSize.isAccessibilitySize {
                VStack(spacing: 12) { deny; approve }.disabled(busy)
            } else {
                HStack { deny; Spacer(); approve }.disabled(busy)
            }
            if busy { ProgressView() }
        }.padding(12).phrenCard().accessibilityElement(children: .contain)
    }
    private var deny: some View {
        Button(role: .destructive) { answer(false) } label: {
            Text("Deny").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.bordered).accessibilityIdentifier("chat-approval-deny")
    }
    private var approve: some View {
        Button { answer(true) } label: {
            Text("Approve").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.borderedProminent).tint(PhrenTheme.cyan).accessibilityIdentifier("chat-approval-approve")
    }
}

struct ChatQuestionHeaderLabel: View {
    let title: String
    let systemImage: String

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(PhrenTheme.Font.caption.weight(.semibold))
            .foregroundStyle(PhrenTheme.cyan)
            .lineLimit(1)
    }
}

struct ChatQuestionExpandButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(PhrenTheme.Font.caption.weight(.semibold))
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(PhrenTheme.textMuted)
        .accessibilityLabel("Expand questions")
        .accessibilityIdentifier("chat-question-expand")
    }
}

struct ChatQuestionOptionRow: View {
    let label: String
    var detail: String? = nil
    var preview: String? = nil
    var selected = false
    var multi = false
    var inline = true
    var busy = false
    var radius = PhrenTheme.Radius.small
    var minimumHeight: CGFloat? = 44
    var colorDot: Color? = nil
    var provider: String? = nil
    var trailingCaption: String? = nil
    var badge: String? = nil
    var muted = false
    let action: () -> Void

    var body: some View {
        PhrenOptionRow(title: label, caption: detail, selected: selected,
                       mark: multi ? .check : .radio, disabled: busy,
                       glyph: glyph,
                       trailing: trailing,
                       detail: preview.map { value in AnyView(previewContent(value)) },
                       radius: radius, minimumHeight: minimumHeight ?? 44, muted: muted, action: action)
            // The preview sits in a scroller, which drops it from the button's label.
            .accessibilityValue(preview ?? "")
    }

    private var glyph: AnyView? {
        if let colorDot {
            return AnyView(Circle().fill(colorDot).frame(width: 8, height: 8).padding(.top, PhrenTheme.Space.xs))
        }
        if let provider { return AnyView(AgentProviderGlyph(source: provider, size: 18)) }
        return nil
    }

    private var trailing: AnyView? {
        if let trailingCaption { return AnyView(PhrenOptionRow.trailingCaption(trailingCaption)) }
        if let badge { return AnyView(PhrenChip(text: badge)) }
        return nil
    }

    private func previewContent(_ value: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(value).font(PhrenTheme.Font.monoCaption2).foregroundStyle(PhrenTheme.text)
                .lineLimit(inline ? 6 : nil).fixedSize(horizontal: true, vertical: true)
                .padding(8)
        }
        .background(PhrenTheme.bgSunken, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous)
            .stroke(PhrenTheme.border, lineWidth: 1))
        .padding(.top, 2)
    }
}

/// One card for the agent's questions: Codex's `request_user_input` (options
/// for the synchronous tool; typed answers for async prompts) and Claude Code's `AskUserQuestion` (options, a typed "Other…", or a
/// free-text answer, sent as the approval's `updatedInput`). Each question is
/// its own section; one Send answers them all, since the agent takes them in
/// a single reply.
///
/// Above the composer the card is a window: past the cap the questions scroll
/// inside it and a fade shows there is more. "Expand" opens the same questions
/// and the same draft answers as a full sheet, where nothing is cut.
struct ChatQuestionCard: View {
    let prompt: AgentQuestionPrompt
    let busy: Bool
    var title = "Your input"
    /// Claude and asynchronous Codex prompts accept a typed answer beside options.
    var allowsTyping = false
    /// Decline to answer (Claude: the permission is denied and the agent
    /// carries on without an answer).
    var skip: (() -> Void)? = nil
    /// Where the terminal can still be opened while the card is up.
    var headerAccessory: AnyView? = nil
    let answer: ([AgentQuestionAnswer]) -> Void
    @State private var answers: [Int: AgentQuestionAnswer] = [:]
    @State private var questionsHeight: CGFloat = 0
    @State private var expanded = false
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var typing: Int?
    private static let scrollCap: CGFloat = 360

    private var current: [AgentQuestionAnswer] { prompt.questions.indices.map { answers[$0] ?? .init() } }
    private var answeredCount: Int { zip(prompt.questions, current).filter { $0.0.isFreeText ? !$0.1.text.isEmpty : !$0.1.selections.isEmpty || !$0.1.text.isEmpty }.count }
    private var overflows: Bool { questionsHeight > Self.scrollCap }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                ChatQuestionHeaderLabel(title: title, systemImage: allowsTyping ? "questionmark.bubble" : "bubble.left.and.text.bubble.right")
                Spacer(minLength: 0)
                if prompt.questions.count > 1 {
                    Text("\(answeredCount) of \(prompt.questions.count)").font(.caption2.monospacedDigit()).foregroundStyle(PhrenTheme.textMuted)
                        .accessibilityLabel("\(answeredCount) of \(prompt.questions.count) answered")
                }
                if let headerAccessory { headerAccessory }
                ChatQuestionExpandButton { expanded = true }
            }
            let questions = questionList(inline: true).background(GeometryReader { geometry in
                Color.clear.preference(key: ChatQuestionsHeight.self, value: geometry.size.height)
            })
            Group {
                if overflows {
                    ScrollView(showsIndicators: true) { questions }.frame(height: Self.scrollCap)
                        .mask(
                            // Fade the last rows out so the cut reads as "more below", not as the end.
                            VStack(spacing: 0) {
                                Color.black
                                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 36)
                            })
                        .overlay(alignment: .bottom) {
                            Button { expanded = true } label: {
                                Label("Show all", systemImage: "chevron.down").font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .background(PhrenTheme.surfaceRaised, in: Capsule())
                                    .overlay(Capsule().stroke(PhrenTheme.border, lineWidth: 1))
                            }.buttonStyle(.plain).foregroundStyle(PhrenTheme.text).padding(.bottom, 4)
                                .accessibilityIdentifier("chat-question-show-all")
                        }
                } else { questions }
            }.onPreferenceChange(ChatQuestionsHeight.self) { questionsHeight = $0 }
            sendRow
        }.padding(16).phrenCard()
            .overlay(alignment: .topLeading) {
                Color.clear.frame(width: 1, height: 1).accessibilityElement()
                    .accessibilityLabel(title).accessibilityIdentifier("chat-question")
            }
            .sheet(isPresented: $expanded) { expandedSheet }
    }

    /// Skip beside Send; Send counts down what is still unanswered.
    @ViewBuilder private var sendRow: some View {
        // Accessibility sizes stack the two buttons so neither label is cut.
        if typeSize.isAccessibilitySize { VStack(spacing: 10) { sendButton; skipButton } } else { HStack(spacing: 12) { skipButton; sendButton } }
    }
    @ViewBuilder private var skipButton: some View {
        if let skip {
            Button("Skip", action: skip).buttonStyle(.bordered).disabled(busy)
                .frame(maxWidth: typeSize.isAccessibilitySize ? .infinity : nil)
                .accessibilityIdentifier("chat-question-skip")
        }
    }
    private var sendButton: some View {
        Button { answer(current) } label: {
            if busy { ProgressView().frame(maxWidth: .infinity) } else { Text("Send answer").frame(maxWidth: .infinity) }
        }.buttonStyle(.borderedProminent).tint(PhrenTheme.cyan)
            .disabled(busy || !prompt.isAnswered(current))
    }

    /// The whole question set with room to read: every question, description
    /// and preview in full, the same draft answers, Send pinned at the bottom.
    private var expandedSheet: some View {
        PhrenNavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    questionList(inline: false).padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
                }
                Divider().overlay(PhrenTheme.border)
                sendRow.padding(16)
            }
            .background(PhrenTheme.bg)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { expanded = false }.accessibilityIdentifier("chat-question-collapse") } }
            .accessibilityIdentifier("chat-question-sheet")
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: busy) { _, now in if now { expanded = false } }
    }

    private func questionList(inline: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(prompt.questions.indices, id: \.self) { index in
                let question = prompt.questions[index]
                if index > 0 { Divider().overlay(PhrenTheme.border).padding(.vertical, 2) }
                HStack(spacing: 8) {
                    if let header = question.header, !header.isEmpty {
                        Text(header).font(.caption.weight(.medium)).lineLimit(1).foregroundStyle(PhrenTheme.sessionProject)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(PhrenTheme.sessionProject.opacity(0.1), in: Capsule())
                    }
                    if prompt.questions.count > 1 {
                        Text("Question \(index + 1)").font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                    }
                }
                // Full text always: a question is never truncated, in either mode.
                Text(question.question).font(.headline).foregroundStyle(PhrenTheme.text).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if question.isFreeText {
                    typedRow(index, question: question, placeholder: question.kind == "number" ? "Enter a number" : "Type your answer")
                } else {
                    ForEach(question.options.indices, id: \.self) { option in optionRow(index, question: question, option: option, inline: inline) }
                    if allowsTyping { typedRow(index, question: question, placeholder: "Other…") }
                }
            }
        }
    }
    private func optionRow(_ index: Int, question: AgentQuestionPrompt.Question, option: Int, inline: Bool) -> some View {
        let multi = question.multiSelect == true
        let selected = answers[index, default: .init()].selections.contains(option)
        let choice = question.options[option]
        return ChatQuestionOptionRow(label: choice.label, detail: choice.description, preview: choice.preview,
                                     selected: selected, multi: multi, inline: inline, busy: busy) {
            var answer = answers[index, default: .init()]
            if multi {
                if selected { answer.selections.removeAll { $0 == option } } else { answer.selections.append(option) }
            } else {
                // One answer per question: an option replaces typed text.
                answer.selections = [option]; answer.text = ""; typing = nil
            }
            answers[index] = answer
        }
    }
    private func typedRow(_ index: Int, question: AgentQuestionPrompt.Question, placeholder: String) -> some View {
        let text = Binding<String>(
            get: { answers[index, default: .init()].text },
            set: { value in
                var answer = answers[index, default: .init()]
                answer.text = value
                // Typing an "Other" answers a single-choice question by itself.
                if !question.isFreeText, question.multiSelect != true, !value.isEmpty { answer.selections = [] }
                answers[index] = answer
            })
        let active = !text.wrappedValue.isEmpty
        return HStack(alignment: .center, spacing: 10) {
            Image(systemName: active ? "pencil.circle.fill" : "pencil.circle").foregroundStyle(active ? PhrenTheme.cyan : PhrenTheme.textDim)
            TextField(placeholder, text: text, axis: .vertical).lineLimit(1...4)
                .foregroundStyle(PhrenTheme.text).focused($typing, equals: index)
                .keyboardType(question.kind == "number" ? .numbersAndPunctuation : .default)
                .accessibilityIdentifier("chat-question-typed-\(index)")
        }.padding(12).background(active ? PhrenTheme.cyan.opacity(0.1) : PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
            .disabled(busy)
    }
}

private struct ChatQuestionsHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct ChatTerminalQuestionCard<Terminal: View, Secret: View>: View {
    let providerName: String
    let prompt: AgentTerminalPrompt
    let answering: Bool
    let disabled: Bool
    @ViewBuilder let terminal: () -> Terminal
    @ViewBuilder let secret: () -> Secret
    let answer: (AgentAnswerKey) -> Void
    @State private var selectedKey: AgentAnswerKey?
    @State private var expanded = false

    private var title: String { "\(providerName) asks" }
    private var yesKey: AgentAnswerKey { isMenu ? .enter : .yes }
    private var message: String {
        if let explanation = prompt.explanation, explanation != prompt.command { return explanation }
        if prompt.command != nil { return "Run this command?" }
        return prompt.toolName.map { "Allow \($0)?" } ?? "Allow this action?"
    }
    private var isMenu: Bool {
        let tool = prompt.toolName?.lowercased() ?? ""
        if tool.contains("question") || tool.contains("select") { return true }
        guard let message = prompt.message,
              let input = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any] else { return false }
        return input["questions"] != nil || input["options"] != nil || input["choices"] != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                ChatQuestionHeaderLabel(title: title, systemImage: "questionmark.bubble")
                Spacer(minLength: 0)
                terminal()
                secret()
                ChatQuestionExpandButton { expanded = true }
            }
            promptContent(inline: true)
            answerRow("Yes", key: yesKey)
            answerRow("No", key: .escape)
        }
        .padding(16)
        .phrenCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-answer-keys")
        .sheet(isPresented: $expanded) { expandedSheet }
        .onChange(of: answering) { _, now in if now { expanded = false } }
    }

    private func promptContent(inline: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message)
                .font(PhrenTheme.Font.body)
                .foregroundStyle(PhrenTheme.text)
                .lineLimit(inline ? 6 : nil)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let command = prompt.command {
                Text(command)
                    .font(PhrenTheme.Font.monoFootnote)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(inline ? 3 : nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(inline ? "chat-terminal-prompt" : "chat-terminal-prompt-expanded")
    }

    private func answerRow(_ label: String, key: AgentAnswerKey) -> some View {
        ChatQuestionOptionRow(label: label, selected: answering && selectedKey == key, busy: disabled,
                              radius: PhrenTheme.Radius.questionOption, minimumHeight: 44) {
            selectedKey = key
            answer(key)
        }
        .accessibilityLabel(key.spoken)
        .accessibilityIdentifier("chat-answer-key:\(key.rawValue)")
    }

    private var expandedSheet: some View {
        PhrenNavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    promptContent(inline: false)
                    answerRow("Yes", key: yesKey)
                    answerRow("No", key: .escape)
                }
                .padding(16)
            }
            .background(PhrenTheme.bg)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { expanded = false }.accessibilityIdentifier("chat-question-collapse")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

/// A Codex terminal dialog whose command and options the Hook could read:
/// asked with the same card as Claude's AskUserQuestion, answered by sending
/// the option's own key (`y`, `p`, `Esc`) through `/v1/keys`.
struct ChatChoiceQuestionCard: View {
    let choice: AgentPromptChoice
    let id: String
    let title: String
    let busy: Bool
    var terminal: AnyView? = nil
    let answer: (AgentAnswerKey) -> Void

    var body: some View {
        if let prompt = choice.prompt(id: id) {
            ChatQuestionCard(prompt: prompt, busy: busy, title: title, headerAccessory: terminal) { answers in
                guard let key = choice.answerKey(selections: answers.first?.selections ?? []) else { return }
                answer(key)
            }
        }
    }
}

/// An older Hook can identify a question without having a response channel.
/// Keep its actual text visible instead of suggesting a normal chat reply.
struct ChatPendingQuestionCard<Terminal: View>: View {
    let prompt: AgentQuestionPrompt
    let count: Int
    @ViewBuilder let terminal: () -> Terminal
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(count > 1 ? "\(count) pending questions" : "Question needs your answer", systemImage: "questionmark.bubble")
                .font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.warning)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(prompt.questions.indices, id: \.self) { index in
                        Text(prompt.questions[index].question).font(.headline).textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 140)
            Text("This connection needs its question answered in the terminal.")
                .font(.caption).foregroundStyle(PhrenTheme.textMuted)
            terminal().buttonStyle(.bordered)
        }.padding(16).phrenCard()
            .overlay(alignment: .topLeading) {
                Color.clear.frame(width: 1, height: 1).accessibilityElement()
                    .accessibilityLabel("Pending question").accessibilityIdentifier("chat-pending-question")
            }
    }
}
