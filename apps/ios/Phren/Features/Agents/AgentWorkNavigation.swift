import PhrenKit
import PhrenLive
import SwiftUI

struct AgentWorkNavigation: Identifiable, Hashable {
    let agent: AgentChild
    let resolution: AgentDestinationResolution
    var id: String { agent.navigationID }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    static func resolve(agent: AgentChild, session: LiveAgentSession,
                        target: AgentChatTarget, hosts: [LiveHost],
                        offlineHostIDs: Set<UUID>) -> Self? {
        guard let resolution = try? AgentDestinationResolver.resolve(
            agent: agent, parentHost: session.host, parentTarget: target,
            hosts: hosts, offlineHostIDs: offlineHostIDs
        ) else { return nil }
        return Self(agent: agent, resolution: resolution)
    }
}

struct AgentWorkDestinationView: View {
    let navigation: AgentWorkNavigation

    var body: some View {
        switch navigation.resolution {
        case .available(let destination), .offline(let destination):
            if destination.isRemote && destination.child == nil {
                AgentChatSheet(session: destination.session(for: navigation.agent),
                               initialTarget: destination.target)
            } else {
                ChildAgentTranscriptView(destination: destination, agent: navigation.agent)
            }
        case .unknown(let computer):
            UnknownAgentComputerView(computer: computer)
        case .starting(let computer):
            StartingAgentComputerView(computer: computer)
        }
    }
}

struct AgentComputerChip: View {
    let computer: AgentComputer
    var unavailable = false
    var unknown = false
    var starting = false

    private var detail: String? {
        if unknown { return "Add computer" }
        if unavailable { return "Unavailable" }
        if starting { return "Starting" }
        return nil
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: unavailable || unknown ? "desktopcomputer.trianglebadge.exclamationmark" : "desktopcomputer")
            Text(computer.name)
            if let detail { Text("· \(detail)") }
        }
        .font(PhrenTheme.Font.caption.weight(.semibold))
        .foregroundStyle(unavailable || unknown ? PhrenTheme.warning : PhrenTheme.cyan)
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background((unavailable || unknown ? PhrenTheme.warning : PhrenTheme.cyan).opacity(0.12), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([computer.name, detail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("agent-computer:\(computer.id.uuidString.lowercased())")
    }
}

private struct UnknownAgentComputerView: View {
    let computer: AgentComputer
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false

    var body: some View {
        VStack(spacing: 0) {
            AgentWorkBackButton { dismiss() }
            VStack(spacing: PhrenTheme.Space.large) {
                Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                    .font(.system(size: 34)).foregroundStyle(PhrenTheme.warning)
                Text("Connect \(computer.name)")
                    .font(PhrenTheme.Font.title2.weight(.bold)).foregroundStyle(PhrenTheme.text)
                Text("This iPhone has not enrolled a connection for that computer. The agent row cannot supply an address, host pin, or key.")
                    .font(PhrenTheme.Font.body).foregroundStyle(PhrenTheme.textMuted)
                    .multilineTextAlignment(.center)
                Button { adding = true } label: {
                    Text("Add computer").frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.borderedProminent).tint(PhrenTheme.accent)
                .accessibilityIdentifier("agent-computer-add")
            }
            .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(PhrenTheme.chatCanvas)
        .sheet(isPresented: $adding) { NavigationStack { LiveHostEditor() } }
    }
}

private struct StartingAgentComputerView: View {
    let computer: AgentComputer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            AgentWorkBackButton { dismiss() }
            VStack(spacing: PhrenTheme.Space.large) {
                ProgressView().tint(PhrenTheme.cyan)
                Text("Starting on \(computer.name)")
                    .font(PhrenTheme.Font.title2.weight(.bold)).foregroundStyle(PhrenTheme.text)
                Text("The remote Hook has not verified this lead's conversation target yet. Refreshing will attach only to its original pane.")
                    .font(PhrenTheme.Font.body).foregroundStyle(PhrenTheme.textMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(PhrenTheme.chatCanvas)
    }
}

private struct AgentWorkBackButton: View {
    let action: () -> Void

    var body: some View {
        HStack {
            Button(action: action) {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain).accessibilityLabel("Back")
            .accessibilityIdentifier("agent-work-back")
            Spacer()
        }
        .foregroundStyle(PhrenTheme.text).padding(.horizontal, 4)
    }
}
