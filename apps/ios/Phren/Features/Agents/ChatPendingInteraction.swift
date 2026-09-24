import PhrenKit
import PhrenLive
import SwiftUI

/// The card above the composer when the agent is waiting on the person: a
/// held permission request (question, plan review or approval), or a
/// structured question the agent asked.
struct ChatPendingInteraction: View {
    let model: AgentChatModel
    let session: LiveAgentSession
    let active: Bool
    /// Runs one agent request as the chat's cancellable send task.
    let run: (@escaping @MainActor () async -> Void) -> Void

    var body: some View {
        if let approval = model.approval, let prompt = approval.questionPrompt, let input = approval.questionInput {
            // Claude Code asks through a permission request: answer it with
            // the request's own input plus the answers; Skip denies.
            ChatQuestionCard(prompt: prompt, busy: model.answering || !active || !model.interactionConnected,
                             title: "\(model.target?.providerName ?? "Claude") has a question", allowsTyping: true,
                             skip: { run { await model.answer(session, approval: approval, approve: false) } }) { answers in
                guard let updated = try? prompt.answeredInput(input, answers: answers) else { return }
                run { await model.answer(session, approval: approval, decision: .approve, updatedInput: updated) }
            }
            .id(approval.id)
            .padding(.horizontal, 12).padding(.vertical, 6)
        } else if let approval = model.approval, let plan = approval.plan {
            // Claude Code's plan review is a permission request for
            // ExitPlanMode: Approve plan builds it, Keep planning denies.
            ChatPlanApprovalCard(plan: plan, id: approval.id, busy: model.answering || !active || !model.interactionConnected) { approve in
                run { await model.answer(session, approval: approval, decision: approve ? .approve : .deny) }
            }
            .id(approval.id)
            .padding(.horizontal, 12).padding(.vertical, 6)
        } else if let approval = model.approval {
            ChatApprovalQuestionCard(approval: approval, providerName: model.target?.providerName ?? "Agent",
                busy: model.answering || !active || !model.interactionConnected,
                terminal: AnyView(ChatAnswerTerminalLink(session: session, target: model.target).accessibilityIdentifier("chat-approval-terminal")),
                answerKey: { key in run { await model.answer(session, key: key) } }) { decision in
                run { await model.answer(session, approval: approval, decision: decision) }
            }
            .id(approval.id)
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
        if model.approval == nil, let prompt = model.question, model.terminalPrompt?.questionPrompt == nil {
            if model.canAnswerQuestion {
                ChatQuestionCard(prompt: prompt, busy: model.answering || !active || !model.connected,
                                 title: "\(model.target?.providerName ?? "Agent") has a question", allowsTyping: prompt.isAsync == true) { answers in
                    run { await model.answer(session, question: prompt, answers: answers) }
                }.id(prompt.id).padding(.horizontal, 12).padding(.vertical, 6)
            } else {
                ChatPendingQuestionCard(prompt: prompt, count: model.pendingQuestionCount) {
                    NavigationLink { HerdrTerminalView(host: session.host, session: session, target: model.target) } label: {
                        Label("Answer in terminal", systemImage: "terminal").frame(maxWidth: .infinity, minHeight: 32)
                    }.accessibilityIdentifier("chat-question-terminal")
                }.padding(.horizontal, 12).padding(.vertical, 6)
            }
        }
    }
}
