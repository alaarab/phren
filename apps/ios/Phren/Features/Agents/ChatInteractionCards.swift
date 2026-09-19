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

/// One card for the agent's questions: Codex's `request_user_input` (options
/// for the synchronous tool; typed answers for async prompts) and Claude Code's `AskUserQuestion` (options, a typed "Other…", or a
/// free-text answer, sent as the approval's `updatedInput`). Each question is
/// its own section; one Send answers them all, since the agent takes them in
/// a single reply.
struct ChatQuestionCard: View {
    let prompt: AgentQuestionPrompt
    let busy: Bool
    var title = "Your input"
    /// Claude and asynchronous Codex prompts accept a typed answer beside options.
    var allowsTyping = false
    /// Decline to answer (Claude: the permission is denied and the agent
    /// carries on without an answer).
    var skip: (() -> Void)? = nil
    let answer: ([AgentQuestionAnswer]) -> Void
    @State private var answers: [Int: AgentQuestionAnswer] = [:]
    @State private var questionsHeight: CGFloat = 0
    @FocusState private var typing: Int?
    private static let scrollCap: CGFloat = 360

    private var current: [AgentQuestionAnswer] { prompt.questions.indices.map { answers[$0] ?? .init() } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: allowsTyping ? "questionmark.bubble" : "bubble.left.and.text.bubble.right")
                .font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
            // Two questions with descriptions and an "Other…" row outgrow a
            // phone above the composer: past the cap the questions scroll and
            // the Send row stays put.
            let questions = questionList.background(GeometryReader { geometry in
                Color.clear.preference(key: ChatQuestionsHeight.self, value: geometry.size.height)
            })
            Group {
                if questionsHeight > Self.scrollCap { ScrollView { questions }.frame(height: Self.scrollCap) } else { questions }
            }.onPreferenceChange(ChatQuestionsHeight.self) { questionsHeight = $0 }
            HStack(spacing: 12) {
                if let skip {
                    Button("Skip", action: skip).buttonStyle(.bordered).disabled(busy)
                        .accessibilityIdentifier("chat-question-skip")
                }
                Button { answer(current) } label: {
                    if busy { ProgressView().frame(maxWidth: .infinity) } else { Text("Send answer").frame(maxWidth: .infinity) }
                }.buttonStyle(.borderedProminent).tint(PhrenTheme.cyan)
                    .disabled(busy || !prompt.isAnswered(current))
            }
        }.padding(16).phrenCard()
            .overlay(alignment: .topLeading) {
                Color.clear.frame(width: 1, height: 1).accessibilityElement()
                    .accessibilityLabel(title).accessibilityIdentifier("chat-question")
            }
    }

    private var questionList: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(prompt.questions.indices, id: \.self) { index in
                let question = prompt.questions[index]
                if index > 0 { Divider().overlay(PhrenTheme.border) }
                if let header = question.header, !header.isEmpty {
                    Text(header).font(.caption.weight(.medium)).lineLimit(1).foregroundStyle(PhrenTheme.sessionProject)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(PhrenTheme.sessionProject.opacity(0.1), in: Capsule())
                }
                Text(question.question).font(.headline).foregroundStyle(PhrenTheme.text).textSelection(.enabled)
                if question.isFreeText {
                    typedRow(index, question: question, placeholder: question.kind == "number" ? "Enter a number" : "Type your answer")
                } else {
                    ForEach(question.options.indices, id: \.self) { option in optionRow(index, question: question, option: option) }
                    if allowsTyping { typedRow(index, question: question, placeholder: "Other…") }
                }
            }
        }
    }
    private func optionRow(_ index: Int, question: AgentQuestionPrompt.Question, option: Int) -> some View {
        let multi = question.multiSelect == true
        let selected = answers[index, default: .init()].selections.contains(option)
        return Button {
            var answer = answers[index, default: .init()]
            if multi {
                if selected { answer.selections.removeAll { $0 == option } } else { answer.selections.append(option) }
            } else {
                // One answer per question: an option replaces typed text.
                answer.selections = [option]; answer.text = ""; typing = nil
            }
            answers[index] = answer
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? (multi ? "checkmark.square.fill" : "checkmark.circle.fill") : (multi ? "square" : "circle"))
                    .foregroundStyle(selected ? PhrenTheme.cyan : PhrenTheme.textDim)
                VStack(alignment: .leading, spacing: 4) {
                    Text(question.options[option].label).foregroundStyle(PhrenTheme.text)
                    if let detail = question.options[option].description, !detail.isEmpty {
                        Text(detail).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                }
                Spacer(minLength: 0)
            }.padding(12).background(selected ? PhrenTheme.cyan.opacity(0.1) : PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
        }.buttonStyle(.plain).disabled(busy)
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
