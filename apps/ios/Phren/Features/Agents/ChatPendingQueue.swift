import PhrenKit
import PhrenLive
import SwiftUI

/// Readiness holds stay above the input until the harness can receive them.
/// Unsent readiness holds only. Harness queue items live in the transcript.
struct ChatPendingQueue: View {
    let model: AgentChatModel
    let session: LiveAgentSession
    let active: Bool
    /// Runs one agent request as the chat's cancellable send task.
    let run: (@escaping @MainActor () async -> Void) -> Void
    /// Editing a held message puts it back in the composer, focused.
    let edit: () -> Void
    @State private var queueHeight: CGFloat = 0

    private struct ChatQueueHeight: PreferenceKey {
        static let defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
    }

    var body: some View {
        if !model.localPendingMessages.isEmpty {
            // Exactly as tall as its rows, and a scroller only once they
            // pass the cap. (`frame(maxHeight:)` around a ViewThatFits
            // stretched to the cap and centred the rows in it — the hole
            // above the steer; a ScrollView that is always there clips
            // rows the measurement has not caught up with.)
            let rows = queuedMessages.padding(.horizontal, 12)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: ChatQueueHeight.self, value: geometry.size.height)
                })
            Group {
                if queueHeight > 190 { ScrollView { rows }.frame(height: 190) } else { rows }
            }
            .onPreferenceChange(ChatQueueHeight.self) { queueHeight = $0 }
            .padding(.bottom, 2)
        }
    }

    private var queuedMessages: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(model.localPendingMessages) { item in
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.pendingLabel(item)).font(PhrenTypography.caption)
                            .foregroundStyle(PhrenTheme.textMuted)
                            .accessibilityIdentifier("chat-pending-reason:\(item.id)")
                        if !item.text.isEmpty {
                            Text(item.text).font(.system(size: 14, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                                .lineLimit(3).textSelection(.enabled)
                        }
                        if !item.attachments.isEmpty {
                            Text("\(item.attachments.count) attachment\(item.attachments.count == 1 ? "" : "s")")
                                .font(.caption2).foregroundStyle(PhrenTheme.chatNeutralDim)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 0) {
                        PhrenIconButton(icon: "arrow.up", label: "Send now") {
                            run { await model.sendNow(item, session) }
                        }.accessibilityIdentifier("chat-queued-send:\(item.id)")
                            .disabled(!active || model.pendingReason != nil || model.sending)
                        PhrenIconButton(icon: "pencil", label: "Edit") { model.edit(item); edit() }
                            .accessibilityIdentifier("chat-queued-edit:\(item.id)")
                        PhrenIconButton(icon: "xmark", label: "Remove pending message") { model.remove(item) }
                            .accessibilityIdentifier("chat-queued-remove:\(item.id)")
                    }.font(.system(size: 15)).foregroundStyle(PhrenTheme.chatNeutral).buttonStyle(.plain)
                }
                .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 6)
                .background(PhrenTheme.chatUserBubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .opacity(0.5)
                .overlay(alignment: .topLeading) {
                    Color.clear.frame(width: 1, height: 1).accessibilityElement()
                        .accessibilityLabel("Pending message").accessibilityIdentifier("chat-queued-tag:\(item.id)")
                }
                .padding(.leading, 30)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-queued:\(item.id)")
            }
        }
        .accessibilityIdentifier("chat-queue")
    }
}
