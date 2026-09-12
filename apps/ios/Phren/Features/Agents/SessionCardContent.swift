import PhrenKit
import SwiftUI

extension LiveWorkspaces.Tab.Activity {
    var color: Color {
        switch self {
        case .working: PhrenTheme.cyan
        case .waiting: PhrenTheme.warning
        case .error: PhrenTheme.danger
        case .done: PhrenTheme.success
        case .idle, .unknown: PhrenTheme.textMuted
        }
    }
    var icon: String {
        switch self {
        case .working: "bolt.fill"
        case .waiting: "pause.fill"
        case .error: "exclamationmark"
        case .done: "checkmark"
        case .idle: "moon"
        case .unknown: "questionmark"
        }
    }
}

/// Shared compact content for overview, computer, and project session lists.
struct SessionCardContent: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let session: LiveAgentSession
    let fresh: Bool
    let subtitle: String
    let identifierPrefix: String

    var body: some View {
        HStack(spacing: 9) {
            SessionActivityIndicator(tab: session.tab, fresh: fresh)
                .accessibilityIdentifier("\(identifierPrefix)-context:\(session.accessibilityKey)")
            VStack(alignment: .leading, spacing: 3) {
                Text(session.tab.displayTitle)
                    .font(.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                    .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                Text(subtitle).font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(textSize.isAccessibilitySize ? nil : 1)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, 10).padding(.trailing, 2).padding(.vertical, 8)
        .frame(minHeight: 60)
        .overlay(alignment: .leading) {
            if fresh && session.tab.activity == .working {
                Capsule().fill(PhrenTheme.cyan).frame(width: 3, height: 24)
                    .accessibilityLabel("Agent is active")
                    .accessibilityIdentifier("\(identifierPrefix)-running:\(session.accessibilityKey)")
            }
        }
        .contentShape(Rectangle())
    }
}

private struct SessionActivityIndicator: View {
    let tab: LiveWorkspaces.Tab
    let fresh: Bool
    private var color: Color { fresh ? tab.activity.color : PhrenTheme.textMuted }
    private var percent: Double? { tab.contextUsedPercent }

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.18), lineWidth: 2).frame(width: 29, height: 29)
            if let percent {
                Circle().trim(from: 0, to: percent / 100)
                    .stroke(color.opacity(fresh ? 0.85 : 0.4), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 29, height: 29)
                Text("\(Int(percent.rounded()))%")
                    .font(.system(size: 9, weight: .semibold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(fresh ? PhrenTheme.text : PhrenTheme.textMuted)
            } else {
                Image(systemName: tab.activity.icon).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(color)
            }
            if fresh && tab.activity == .working {
                SessionActivityArc(color: color).frame(width: 36, height: 36)
            }
        }
        .frame(width: 36, height: 36)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context used")
        .accessibilityValue(percent.map { "\(Int($0.rounded()))%" } ?? "Unavailable")
    }
}

/// Animate only the arc's transform, without a per-frame timeline or a 20 Hz cap.
/// Ordinary snapshot/context updates preserve the ongoing rotation.
private struct SessionActivityArc: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var spinning = false
    let color: Color
    private var shouldAnimate: Bool { visible && scenePhase == .active && !reduceMotion }

    var body: some View {
        Circle().trim(from: 0, to: 0.22)
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .rotationEffect(.degrees(spinning ? 270 : -90))
            .animation(spinning ? .linear(duration: 0.9).repeatForever(autoreverses: false) : nil,
                       value: spinning)
            .onAppear { visible = true }
            .onDisappear { visible = false; spinning = false }
            .onChange(of: shouldAnimate, initial: true) { _, active in spinning = active }
    }
}

struct SessionPinButton: View {
    let session: LiveAgentSession
    let pinned: Bool
    let identifierPrefix: String
    @Binding var data: Data
    @State private var error: String?

    var body: some View {
        Button {
            do {
                let current = try LiveSessionPreferences.read(data)
                data = try LiveSessionPreferences.setPinned(!current.isPinned(session.id), for: session.id, in: data)
            } catch { self.error = error.localizedDescription }
        } label: {
            Image(systemName: pinned ? "pin.fill" : "pin")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(pinned ? PhrenTheme.cyan : PhrenTheme.textDim)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pinned ? "Unpin session" : "Pin session")
        .accessibilityIdentifier("\(identifierPrefix)-pin:\(session.accessibilityKey)")
        .alert("Couldn't update pin", isPresented: $error.isPresent()) {
            Button("OK", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }
}

extension LiveAgentSession {
    // Accessibility names retain the existing overview destination format;
    // persistence uses the structured ID, never this display-only string.
    var accessibilityKey: String { "\(host.id):\(host.muxID):\(workspaceID):\(tab.id)" }
}

extension View {
    func sessionCard() -> some View {
        self.background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(PhrenTheme.border, lineWidth: 1))
    }

    func separatedSessionRow() -> some View {
        self.listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden).listRowBackground(PhrenTheme.bg)
    }
}
