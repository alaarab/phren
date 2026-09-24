import SwiftUI
import WidgetKit

/// Root view for every supported family — switches on `widgetFamily` rather
/// than defining four separate `Widget` types, since all four are really one
/// glanceable surface over the same snapshot.
struct PhrenWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PhrenEntry

    var body: some View {
        content
            .containerBackground(containerColor, for: .widget)
            // Whole-widget fallback tap target (used by systemSmall and both
            // Lock Screen families outright, and by systemMedium whenever a
            // host surface doesn't honor the per-region `Link`s below).
            .widgetURL(URL(string: "phren://projects"))
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall:
            SmallMemoryView(snapshot: entry.snapshot)
        case .systemMedium:
            MediumMemoryView(snapshot: entry.snapshot)
        case .accessoryCircular:
            CircularMemoryView(snapshot: entry.snapshot)
        case .accessoryRectangular:
            RectangularMemoryView(snapshot: entry.snapshot)
        default:
            SmallMemoryView(snapshot: entry.snapshot)
        }
    }

    /// Lock Screen accessories render through the system's own vibrant or
    /// monochrome material — a custom colored background there is either
    /// ignored or looks wrong, so those stay `.clear`. Home Screen families
    /// get the fixed phren navy regardless of the system's light/dark mode
    /// (the brand is dark-only per PhrenTheme) — background and foreground
    /// are chosen together below, so the pair stays legible either way.
    private var containerColor: Color {
        switch family {
        case .accessoryCircular, .accessoryRectangular: return .clear
        default: return WidgetTheme.bg
        }
    }
}

// MARK: - systemSmall

struct SmallMemoryView: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let snapshot: WidgetSnapshot?

    private var isFullColor: Bool { renderingMode == .fullColor }

    var body: some View {
        if let snapshot {
            VStack(alignment: .leading, spacing: 4) {
                Text("PHREN")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(isFullColor ? WidgetTheme.accent : .secondary)
                Spacer(minLength: 2)
                Text(snapshot.memoryCount.map(String.init) ?? "—")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(isFullColor ? WidgetTheme.text : .primary)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .widgetAccentable()
                Text("memories")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isFullColor ? WidgetTheme.textMuted : .secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            OpenPhrenEmptyView()
        }
    }
}

// MARK: - systemMedium

struct MediumMemoryView: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let snapshot: WidgetSnapshot?

    private var isFullColor: Bool { renderingMode == .fullColor }

    var body: some View {
        if let snapshot {
            HStack(alignment: .top, spacing: 12) {
                Link(destination: URL(string: "phren://projects")!) {
                    memoryColumn(snapshot)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Rectangle()
                    .fill(WidgetTheme.border)
                    .frame(width: 1)

                Link(destination: URL(string: "phren://tasks")!) {
                    taskColumn(snapshot)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } else {
            OpenPhrenEmptyView()
        }
    }

    @ViewBuilder
    private func memoryColumn(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("PHREN")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(isFullColor ? WidgetTheme.accent : .secondary)
            Text(snapshot.memoryCount.map(String.init) ?? "—")
                .font(.system(size: 32, weight: .bold, design: .rounded))
                .foregroundStyle(isFullColor ? WidgetTheme.text : .primary)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .widgetAccentable()
            Text("memories")
                .font(.caption2)
                .foregroundStyle(isFullColor ? WidgetTheme.textMuted : .secondary)
            if let projects = snapshot.projectCount {
                Text("\(projects) projects")
                    .font(.caption2)
                    .foregroundStyle(isFullColor ? WidgetTheme.textMuted : .secondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private func taskColumn(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("TOP TASK")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .tracking(1.0)
                .foregroundStyle(isFullColor ? WidgetTheme.cyan : .secondary)
            if let topTask = snapshot.topTask {
                Text(topTask.text).privacySensitive()
                    .font(.caption.weight(.medium))
                    .foregroundStyle(isFullColor ? WidgetTheme.text : .primary)
                    .lineLimit(2)
                Text(topTask.project).privacySensitive()
                    .font(.caption2)
                    .foregroundStyle(isFullColor ? WidgetTheme.textMuted : .secondary)
                    .lineLimit(1)
            } else {
                Text("Nothing active")
                    .font(.caption)
                    .foregroundStyle(isFullColor ? WidgetTheme.textMuted : .secondary)
            }
            Spacer(minLength: 0)
            if let lastSyncedAt = snapshot.lastSyncedAt {
                (Text("synced ") + Text(lastSyncedAt, style: .relative))
                    .font(.caption2)
                    .foregroundStyle(isFullColor ? WidgetTheme.textMuted : .secondary)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - accessoryCircular (Lock Screen)

struct CircularMemoryView: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let snapshot {
                VStack(spacing: 0) {
                    Text(snapshot.memoryCount.map(String.init) ?? "—")
                        .font(.system(.title2, design: .rounded).weight(.bold))
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                        .widgetAccentable()
                    Text("memory")
                        .font(.system(size: 9))
                }
            } else {
                Image(systemName: "arrow.up.forward.app")
                    .font(.title3)
                    .widgetAccentable()
            }
        }
    }
}

// MARK: - accessoryRectangular (Lock Screen)

struct RectangularMemoryView: View {
    let snapshot: WidgetSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let snapshot {
                Text("\(snapshot.memoryCount.map(String.init) ?? "—") memories")
                    .font(.headline)
                    .widgetAccentable()
                    .lineLimit(1)
                Text(snapshot.topTask?.text ?? "Nothing active").privacySensitive()
                    .font(.caption)
                    .lineLimit(1)
            } else {
                Text("phren")
                    .font(.headline)
                    .widgetAccentable()
                Text("Open the app to sign in")
                    .font(.caption)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Empty state (no snapshot written yet)

/// First install, or the app has never completed a refresh cycle. Shown by
/// the two Home Screen families instead of a blank card or fabricated
/// placeholder numbers.
struct OpenPhrenEmptyView: View {
    @Environment(\.widgetRenderingMode) private var renderingMode

    private var isFullColor: Bool { renderingMode == .fullColor }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PHREN")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(isFullColor ? WidgetTheme.accent : .secondary)
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.forward.app")
                .font(.title2)
                .foregroundStyle(isFullColor ? WidgetTheme.cyan : .primary)
            Text("Open phren")
                .font(.caption.weight(.semibold))
                .foregroundStyle(isFullColor ? WidgetTheme.text : .primary)
            Text("Sign in to explore your memory")
                .font(.caption2)
                .foregroundStyle(isFullColor ? WidgetTheme.textMuted : .secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
