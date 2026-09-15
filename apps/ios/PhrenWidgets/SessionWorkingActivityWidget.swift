import ActivityKit
import SwiftUI
import WidgetKit

struct SessionWorkingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionWorkingActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 9) {
                    PhrenActivityMark(size: 26)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.project).font(.headline).lineLimit(1)
                        if let branch = context.state.branch {
                            Label(branch, systemImage: "arrow.triangle.branch")
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer()
                    ProviderActivityGlyph(provider: context.state.provider, size: 23)
                }
                HStack {
                    Label(context.isStale ? "Timed out" : context.state.state,
                          systemImage: context.isStale ? "clock.badge.exclamationmark" : "bolt.fill")
                        .foregroundStyle(WidgetTheme.cyan)
                    Spacer()
                    Text(context.state.startedAt, style: .timer).monospacedDigit()
                        .accessibilityLabel("Elapsed \(SessionElapsedTime.format(from: context.state.startedAt, to: .now))")
                }
                .font(.subheadline.weight(.semibold))
                if !context.isStale, let tool = context.state.toolName {
                    Label(tool, systemImage: "hammer.fill")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(16)
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
            .widgetURL(routeURL(context.attributes.routeID))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    PhrenActivityMark(size: 24)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.startedAt, style: .timer)
                        .font(.caption.monospacedDigit()).foregroundStyle(WidgetTheme.cyan)
                        .accessibilityLabel("Elapsed \(SessionElapsedTime.format(from: context.state.startedAt, to: .now))")
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.project).font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 9) {
                        ProviderActivityGlyph(provider: context.state.provider, size: 21)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(context.isStale ? "Timed out" : context.state.toolName ?? context.state.state)
                                .font(.subheadline).lineLimit(1)
                            if let branch = context.state.branch {
                                Text(branch).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                    }
                }
            } compactLeading: {
                PhrenActivityMark(size: 20)
            } compactTrailing: {
                Text(context.state.startedAt, style: .timer).font(.caption2.monospacedDigit())
                    .accessibilityLabel("Elapsed \(SessionElapsedTime.format(from: context.state.startedAt, to: .now))")
            } minimal: {
                PhrenActivityMark(size: 18)
            }
            .widgetURL(routeURL(context.attributes.routeID))
        }
    }

    private func routeURL(_ routeID: String) -> URL? {
        var components = URLComponents()
        components.scheme = "phren"
        components.host = "session"
        components.queryItems = [URLQueryItem(name: "route", value: routeID)]
        return components.url
    }
}

private struct PhrenActivityMark: View {
    let size: CGFloat

    var body: some View {
        Image("PhrenMark").resizable().scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
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
