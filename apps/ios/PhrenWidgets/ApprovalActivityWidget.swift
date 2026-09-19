import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct ApprovalActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ApprovalActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(context.state.project).foregroundStyle(WidgetTheme.accent)
                    Text("· \(context.state.host)").foregroundStyle(.secondary)
                    Spacer()
                    mark(context)
                }.font(.caption).lineLimit(1)
                Text(context.isStale ? "Request expired" : headline(context))
                    .font(.headline)
                Text(context.isStale ? "Open Phren to check the current request." : context.state.explanation)
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(2).privacySensitive()
                if !context.isStale { actions(context) }
            }.padding(16).activityBackgroundTint(.black).activitySystemActionForegroundColor(.white)
                .widgetURL(context.attributes.openURL ?? URL(string: "phren://agents"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { mark(context) }
                DynamicIslandExpandedRegion(.trailing) { Text(context.state.project).font(.caption).lineLimit(1) }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(context.isStale ? "Request expired" : headline(context)).font(.headline)
                        if !context.isStale {
                            Text(context.state.explanation).font(.caption).lineLimit(2).privacySensitive()
                            actions(context)
                        }
                    }
                }
            } compactLeading: {
                mark(context)
            } compactTrailing: {
                Text(context.isStale ? "Expired" : context.state.question ? "Question" : "Approve?").font(.caption2)
            } minimal: {
                mark(context)
            }.widgetURL(context.attributes.openURL ?? URL(string: "phren://agents"))
        }
    }

    private func headline(_ context: ActivityViewContext<ApprovalActivityAttributes>) -> String {
        context.state.question ? "\(context.state.provider) has a question" : "\(context.state.provider) needs approval"
    }
    private func mark(_ context: ActivityViewContext<ApprovalActivityAttributes>) -> some View {
        Image(systemName: context.state.question ? "questionmark.bubble.fill" : "hand.raised.fill")
            .foregroundStyle(context.state.question ? WidgetTheme.accent : .orange)
    }
    @ViewBuilder private func actions(_ context: ActivityViewContext<ApprovalActivityAttributes>) -> some View {
        if context.state.question {
            // A question is answered in the app, where the choices are shown.
            Link(destination: context.attributes.openURL ?? URL(string: "phren://agents")!) {
                Text("Open").frame(maxWidth: .infinity, minHeight: 32)
            }.buttonStyle(.borderedProminent).tint(WidgetTheme.accent).disabled(context.isStale)
        } else {
            HStack(spacing: 12) {
                Button(intent: AnswerApprovalIntent(requestID: context.attributes.requestID, approve: false)) {
                    Text("Deny").frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.bordered)
                Button(intent: AnswerApprovalIntent(requestID: context.attributes.requestID, approve: true)) {
                    Text("Approve").frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.borderedProminent).tint(WidgetTheme.accent)
            }.disabled(context.isStale)
        }
    }
}
