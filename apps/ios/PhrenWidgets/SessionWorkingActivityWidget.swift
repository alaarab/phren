import ActivityKit
import SwiftUI
import WidgetKit

struct SessionWorkingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionWorkingActivityAttributes.self) { context in
            HStack(spacing: 8) {
                PhrenActivityMark(size: 18)
                Text(context.state.headline).font(.subheadline.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                elapsed(context.state.startedAt)
            }
            .padding(10)
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
            .widgetURL(routeURL(context))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { PhrenActivityMark(size: 18) }
                DynamicIslandExpandedRegion(.trailing) { elapsed(context.state.startedAt) }
                DynamicIslandExpandedRegion(.center) {
                    Text("\(context.state.working) working · \(context.state.waiting) waiting")
                        .font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(context.state.entries.prefix(4)) { entry in
                            HStack(spacing: 6) {
                                ProviderActivityGlyph(provider: entry.provider, size: 16)
                                Text(entry.project).privacySensitive().lineLimit(1)
                                if let tool = entry.tool {
                                    Text("· \(tool)").privacySensitive().foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                Text(entry.computer).privacySensitive().font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            } compactLeading: {
                PhrenActivityMark(size: 16)
            } compactTrailing: {
                Text("\(context.state.working)").font(.caption2.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(context.state.waiting > 0 ? .orange : WidgetTheme.cyan)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background((context.state.waiting > 0 ? Color.orange : WidgetTheme.cyan).opacity(0.15), in: Capsule())
                    .accessibilityLabel("\(context.state.working) working, \(context.state.waiting) waiting")
            } minimal: { PhrenActivityMark(size: 16) }
            .widgetURL(routeURL(context))
        }
    }

    private func elapsed(_ start: Date) -> some View {
        Text(start, style: .timer).font(.caption.monospacedDigit()).foregroundStyle(WidgetTheme.cyan)
            .multilineTextAlignment(.trailing).minimumScaleFactor(0.65)
            .frame(width: 52, alignment: .trailing).clipped()
    }
    private func routeURL(_ context: ActivityViewContext<SessionWorkingActivityAttributes>) -> URL? {
        guard context.state.working + context.state.waiting == 1 else { return URL(string: "phren://agents") }
        var components = URLComponents()
        components.scheme = "phren"; components.host = "session"
        components.queryItems = [URLQueryItem(name: "route", value: context.attributes.routeID)]
        return components.url
    }
}

private struct PhrenActivityMark: View {
    let size: CGFloat

    var body: some View {
        // The mark is the sprite alone on a transparent ground, so it reads
        // at island size instead of vanishing into a dark tile.
        Image("PhrenMark").resizable().scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel("phren")
    }
}

private struct ProviderActivityGlyph: View {
    let provider: String
    let size: CGFloat

    private var asset: String? {
        switch provider.lowercased() {
        case "claude": "ClaudeMark"
        case "codex": "CodexMark"
        case "copilot": "CopilotMark"
        default: nil
        }
    }

    var body: some View {
        if let asset {
            Image(asset).resizable().scaledToFit().frame(width: size, height: size)
        } else {
            Image(systemName: "terminal").frame(width: size, height: size)
        }
    }
}
