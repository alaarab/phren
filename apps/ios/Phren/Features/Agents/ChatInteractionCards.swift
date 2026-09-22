import Foundation
import PhrenKit
import SwiftUI

struct ChatApprovalCard<Terminal: View>: View {
    let approval: AgentApproval
    let busy: Bool
    @ViewBuilder let terminal: () -> Terminal
    let answer: (ApprovalDecision) -> Void
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
                PhrenDisclosure(title: "Action details") {
                    ScrollView { Text(message).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 220)
                }
            }
            terminal().buttonStyle(.bordered).frame(maxWidth: .infinity)
            if approval.conductor != nil { grantAnswers }
            if typeSize.isAccessibilitySize {
                VStack(spacing: 12) { deny; approve }.disabled(busy)
            } else {
                HStack { deny; Spacer(); approve }.disabled(busy)
            }
            if busy { ProgressView() }
        }.padding(12).phrenCard().accessibilityElement(children: .contain)
    }
    /// Grant-scoped answers the Hook writes into `conductor.yaml` while still
    /// approving this call. "Allow for this project" is hidden when the call
    /// has no project to scope a grant to.
    @ViewBuilder private var grantAnswers: some View {
        if let conductor = approval.conductor {
            VStack(spacing: 8) {
                if conductor.project != nil {
                    Button { answer(.allowProject) } label: {
                        Text("Allow for this project").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
                    }.buttonStyle(.bordered).accessibilityIdentifier("chat-approval-allow-project")
                }
                Button { answer(.allowEverywhere) } label: {
                    Text("Allow everywhere").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.bordered).accessibilityIdentifier("chat-approval-allow-everywhere")
            }.disabled(busy)
        }
    }
    private var deny: some View {
        Button(role: .destructive) { answer(.deny) } label: {
            Text("Deny").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.bordered).accessibilityIdentifier("chat-approval-deny")
    }
    private var approve: some View {
        Button { answer(.approve) } label: {
            Text("Approve").lineLimit(1).frame(maxWidth: .infinity, minHeight: 32)
        }.buttonStyle(.borderedProminent).tint(PhrenTheme.cyan).accessibilityIdentifier("chat-approval-approve")
    }
}

/// In-chat permissions use the same header and radio rows as choice questions.
/// The compact approval card above remains available to non-chat surfaces.
struct ChatApprovalQuestionCard: View {
    let approval: AgentApproval
    let providerName: String
    let busy: Bool
    let terminal: AnyView
    let answerKey: (AgentAnswerKey) -> Void
    let answer: (ApprovalDecision) -> Void
    @State private var selected: String?

    private struct Row: Identifiable {
        let id: String
        let label: String
        var description: String? = nil
        var decision: ApprovalDecision? = nil
        var key: AgentAnswerKey? = nil
        var enabled = true
    }

    private var rows: [Row] {
        var result: [Row]
        if let choice = approval.choice, choice.prompt(id: approval.id) != nil {
            result = choice.options.enumerated().map { index, option in
                Row(id: option.answerKey == .escape || option.answerKey == .no || option.label.lowercased() == "no" ? "deny" : index == 0 ? "approve" : "option-\(index)",
                    label: option.label, description: option.description, key: option.answerKey)
            }
        } else if let options = approval.options, !options.isEmpty {
            result = options.map { Row(id: $0.decision.rawValue, label: $0.label, decision: $0.decision) }
        } else {
            result = [Row(id: "approve", label: "Approve", decision: .approve),
                      Row(id: "deny", label: "Deny", decision: .deny)]
        }
        let supplied = approval.choice != nil || approval.options?.isEmpty == false
        if approval.conductor != nil || !supplied {
            let insertion = result.firstIndex { $0.id == "deny" } ?? result.endIndex
            var grants: [Row] = []
            if !result.contains(where: { $0.decision == .allowProject }) {
                grants.append(Row(id: "allow-project", label: "Allow for this project", decision: .allowProject,
                                  enabled: approval.conductor?.project != nil))
            }
            if !result.contains(where: { $0.decision == .allowEverywhere }) {
                grants.append(Row(id: "allow-everywhere", label: "Allow everywhere", decision: .allowEverywhere,
                                  enabled: approval.conductor != nil))
            }
            result.insert(contentsOf: grants, at: insertion)
        }
        return result
    }

    var body: some View {
        if approval.terminalOnly == true || (approval.choice != nil && approval.choice?.prompt(id: approval.id) == nil) {
            terminal
        } else {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    ChatQuestionHeaderLabel(title: "\(providerName) asks", systemImage: "questionmark.bubble")
                        .accessibilityIdentifier("chat-approval")
                    Spacer(minLength: 0)
                    terminal
                }
                Text(approval.choice?.title ?? approval.title ?? approval.toolName ?? "Allow this action?")
                    .font(PhrenTheme.Font.body.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let explanation = approval.explanation, explanation != approval.command,
                   explanation != approval.title, explanation != approval.choice?.title {
                    Text(explanation).font(PhrenTheme.Font.body).foregroundStyle(PhrenTheme.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let command = approval.command {
                    Text(command).font(PhrenTheme.Font.monoFootnote).foregroundStyle(PhrenTheme.textMuted)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-approval-command")
                }
                ForEach(rows) { row in
                    ChatQuestionOptionRow(label: row.label, detail: row.description, selected: selected == row.id,
                        busy: busy || !row.enabled, radius: PhrenTheme.Radius.questionOption) {
                        selected = row.id
                        if let key = row.key { answerKey(key) }
                        else if let decision = row.decision { answer(decision) }
                    }
                    .accessibilityIdentifier("chat-approval-\(row.id)")
                }
                if let message = approval.details ?? approval.message, message != approval.command, message != approval.explanation {
                    PhrenDisclosure(title: "Action details") {
                        Text(message).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted)
                            .textSelection(.enabled)
                    }
                }
            }.padding(16).phrenCard().accessibilityElement(children: .contain)
        }
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
/// Terminal choices fold only long question text and keep options at full height.
/// Multi-question forms open the same questions and drafts in a full sheet.
struct ChatQuestionCard: View {
    let prompt: AgentQuestionPrompt
    let busy: Bool
    var title = "Your input"
    /// Claude and asynchronous Codex prompts accept a typed answer beside options.
    var allowsTyping = false
    var keepsOptionsVisible = false
    /// Decline to answer (Claude: the permission is denied and the agent
    /// carries on without an answer).
    var skip: (() -> Void)? = nil
    /// Where the terminal can still be opened while the card is up.
    var headerAccessory: AnyView? = nil
    let answer: ([AgentQuestionAnswer]) -> Void
    @State private var answers: [Int: AgentQuestionAnswer] = [:]
    @State private var expanded = false
    @State private var questionsHeight: CGFloat = 0
    private static let scrollCap: CGFloat = 360
    private var overflows: Bool { questionsHeight > Self.scrollCap }
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var typing: Int?

    private var current: [AgentQuestionAnswer] { prompt.questions.indices.map { answers[$0] ?? .init() } }
    private var answeredCount: Int { zip(prompt.questions, current).filter { $0.0.isFreeText ? !$0.1.text.isEmpty : !$0.1.selections.isEmpty || !$0.1.text.isEmpty }.count }
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
            if keepsOptionsVisible {
                questionList(inline: true)
            } else {
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
            }
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
                if keepsOptionsVisible {
                    ChatQuestionText(text: question.question, inline: inline) { expanded = true }
                } else {
                    Text(question.question).font(.headline).foregroundStyle(PhrenTheme.text).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
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

/// The fade and expansion belong to the asking text, never to the answers.
private struct ChatQuestionText: View {
    let text: String
    let inline: Bool
    let expand: () -> Void
    @State private var height: CGFloat = 0
    private let cap: CGFloat = 180
    private var folds: Bool { inline && height > cap }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text).font(.headline).foregroundStyle(PhrenTheme.text).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: ChatQuestionsHeight.self, value: geometry.size.height)
                })
                .frame(height: folds ? cap : nil, alignment: .top).clipped()
                .mask {
                    VStack(spacing: 0) {
                        Color.black
                        if folds { LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 24) }
                    }
                }
            if folds {
                Button(action: expand) {
                    Label("Show all", systemImage: "chevron.down").font(.caption.weight(.semibold))
                        .frame(minHeight: 44)
                }.buttonStyle(.plain).foregroundStyle(PhrenTheme.text)
                    .accessibilityIdentifier("chat-question-show-all")
            }
        }.onPreferenceChange(ChatQuestionsHeight.self) { height = $0 }
    }
}

private struct ChatQuestionsHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct ChatTerminalQuestionCard<Terminal: View>: View {
    let providerName: String
    let prompt: AgentTerminalPrompt
    let answering: Bool
    let disabled: Bool
    @ViewBuilder let terminal: () -> Terminal
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
            ChatQuestionCard(prompt: prompt, busy: busy, title: title, keepsOptionsVisible: true, headerAccessory: terminal) { answers in
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
