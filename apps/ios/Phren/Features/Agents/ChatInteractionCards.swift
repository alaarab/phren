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

struct ChatQuestionCard: View {
    let prompt: AgentQuestionPrompt
    let busy: Bool
    let answer: ([[Int]]) -> Void
    @State private var selections: [Int: Set<Int>] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Your input", systemImage: "bubble.left.and.text.bubble.right").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
            ForEach(prompt.questions.indices, id: \.self) { index in
                let question = prompt.questions[index]
                Text(question.question).font(.headline)
                ForEach(question.options.indices, id: \.self) { option in
                    let selected = selections[index, default: []].contains(option)
                    Button {
                        if question.multiSelect == true {
                            if selected { selections[index, default: []].remove(option) } else { selections[index, default: []].insert(option) }
                        } else { selections[index] = [option] }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? PhrenTheme.cyan : PhrenTheme.textDim)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(question.options[option].label).foregroundStyle(PhrenTheme.text)
                                if let detail = question.options[option].description { Text(detail).font(.caption).foregroundStyle(PhrenTheme.textMuted) }
                            }
                            Spacer(minLength: 0)
                        }.padding(12).background(selected ? PhrenTheme.cyan.opacity(0.1) : PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain).disabled(busy)
                }
            }
            Button { answer(prompt.questions.indices.map { selections[$0, default: []].sorted() }) } label: {
                if busy { ProgressView() } else { Text("Send answer").frame(maxWidth: .infinity) }
            }.buttonStyle(.borderedProminent).tint(PhrenTheme.cyan)
                .disabled(busy || !prompt.questions.indices.allSatisfy { !selections[$0, default: []].isEmpty })
        }.padding(16).phrenCard().accessibilityIdentifier("chat-question")
    }
}
