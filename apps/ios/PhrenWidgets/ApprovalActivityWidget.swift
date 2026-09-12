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
                    Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                }.font(.caption).lineLimit(1)
                Text(context.isStale ? "Request expired" : "\(context.state.provider) needs approval")
                    .font(.headline)
                Text(context.isStale ? "Open Phren to check the current request." : context.state.explanation)
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(2).privacySensitive()
                if !context.isStale { actions(context) }
            }.padding(16).activityBackgroundTint(.black).activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "phren://agents"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "hand.raised.fill").foregroundStyle(.orange) }
                DynamicIslandExpandedRegion(.trailing) { Text(context.state.project).font(.caption).lineLimit(1) }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(context.isStale ? "Request expired" : "\(context.state.provider) needs approval").font(.headline)
                        if !context.isStale {
                            Text(context.state.explanation).font(.caption).lineLimit(2).privacySensitive()
                            actions(context)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            } compactTrailing: {
                Text(context.isStale ? "Expired" : "Approve?").font(.caption2)
            } minimal: {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            }.widgetURL(URL(string: "phren://agents"))
        }
    }

    private func actions(_ context: ActivityViewContext<ApprovalActivityAttributes>) -> some View {
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
