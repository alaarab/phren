import PhrenKit
import SwiftUI
import UIKit

struct WorkspaceTreeDisclosure: View {
    let label: String
    let count: Int
    let open: Bool
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                .rotationEffect(.degrees(open ? 0 : -90)).frame(width: 14)
            Text(label).font(.subheadline.weight(.semibold)).lineLimit(1)
            Spacer(); if !open { Text("\(count)").font(.caption) }
        }.foregroundStyle(PhrenTheme.text).frame(minHeight: 38).contentShape(Rectangle())
    }
}

struct WorkspaceTreeAgentLabel: View {
    let tab: LiveWorkspaces.Tab
    var subtitle: String? = nil
    var selected = false
    var tinted = false
    var body: some View {
        HStack(spacing: 9) {
            if tab.agent != nil { AgentProviderGlyph(source: tab.agent, size: 18) }
            else { Image(systemName: "terminal").foregroundStyle(PhrenTheme.textMuted).frame(width: 18) }
            VStack(alignment: .leading, spacing: 2) {
                Text(tab.displayTitle).font(.subheadline).lineLimit(1)
                if let subtitle { Text(subtitle).font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1) }
            }
            Spacer()
            if tab.activity == .working {
                ProgressView().controlSize(.mini).tint(tab.activity.color).accessibilityLabel(tab.status)
            } else {
                Circle().fill(tab.activity.color).frame(width: 7, height: 7).accessibilityLabel(tab.status)
            }
            if selected { Image(systemName: "checkmark").foregroundStyle(PhrenTheme.cyan) }
        }.foregroundStyle(PhrenTheme.text).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            .padding(.horizontal, tinted ? 12 : 0)
            .background(tinted ? tab.activity.color.opacity(selected ? 0.18 : 0.07) : .clear)
            .overlay(alignment: .leading) {
                if tinted && selected { Rectangle().fill(PhrenTheme.accent).frame(width: 3) }
            }
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The same computer → workspace → agent hierarchy used by Herdr, adapted
/// for choosing a live conversation from compact drawers.
struct AgentWorkspaceTree: View {
    /// One tab and the real Herdr workspace it belongs to. Merged groups keep
    /// each tab's own workspace id, so choosing a row still opens the right one.
    private struct Child: Identifiable {
        let workspaceID: String
        let workspaceLabel: String
        let tab: LiveWorkspaces.Tab
        var id: String { workspaceID + ":" + tab.id }
    }
    private struct MatchingGroup: Identifiable {
        let id: String
        let label: String
        let children: [Child]
    }
    let computers: [SessionOverviewMonitor.Computer]
    let query: String
    let current: LiveAgentSession.ID?
    var recent = false
    let choose: (LiveAgentSession) -> Void
    @State private var collapsed: Set<String> = []

    var body: some View {
        if recent {
            ForEach(SessionRecency.ordered(computers.flatMap { computer in
                matching(computer).flatMap { group in group.children.map {
                    LiveAgentSession(host: computer.host, workspaceID: $0.workspaceID, workspaceName: $0.workspaceLabel,
                                     tab: $0.tab, workspaceTabCount: group.children.count)
                } }
            })) { item in
                sessionButton(item, subtitle: "\(item.projectDisplayName(nil)) · \(item.host.name)")
            }
        } else {
        ForEach(computers) { computer in
            let groups = matching(computer)
            if !groups.isEmpty {
                Section {
                    // Keyed by computer + project: two computers can share
                    // a project name, and a bare name would drop the second.
                    ForEach(groups.map { (key: computer.host.id.uuidString + ":" + $0.id, group: $0) }, id: \.key) { entry in
                        let group = entry.group, key = entry.key
                        let open = !collapsed.contains(key)
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) {
                                if open { collapsed.insert(key) } else { collapsed.remove(key) }
                            }
                        } label: { WorkspaceTreeDisclosure(label: group.label, count: group.children.count, open: open).padding(.horizontal, 12) }
                            .buttonStyle(.plain).accessibilityIdentifier("agent-workspace:\(computer.host.id):\(group.id)")
                        if open {
                            ForEach(group.children.filter { $0.tab.agent != nil || ($0.tab.agentPaneCount ?? 0) > 0 }.map { (key: key + ":" + $0.id, child: $0) }, id: \.key) { entry in
                                let item = LiveAgentSession(host: computer.host, workspaceID: entry.child.workspaceID,
                                                            workspaceName: entry.child.workspaceLabel, tab: entry.child.tab,
                                                            workspaceTabCount: group.children.count)
                                sessionButton(item, subtitle: nil)
                            }
                        }
                    }
                } header: {
                    if computers.count > 1 {
                        Text(computer.host.name).font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 12)
                    }
                }
            }
        }
        }
    }

    private func sessionButton(_ item: LiveAgentSession, subtitle: String?) -> some View {
        Button { choose(item) } label: {
            WorkspaceTreeAgentLabel(tab: item.tab, subtitle: subtitle, selected: item.id == current, tinted: true)
        }.buttonStyle(.plain)
            .accessibilityIdentifier("switch-session:\(item.host.id):\(item.host.muxID):\(item.workspaceID):\(item.tab.id)")
    }

    private func matching(_ computer: SessionOverviewMonitor.Computer) -> [MatchingGroup] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let groups = computer.monitor.snapshot?.groups else { return [] }
        // Herdr opens a fresh workspace each time the same project is started,
        // so "Phren", "phren" and the next one would each get their own row.
        // Fold workspaces that name the same project into one entry; every tab
        // keeps its own workspace id for opening.
        var merged: [String: (label: String, children: [Child])] = [:]
        var order: [String] = []
        for group in groups {
            let children = group.children.filter { tab in
                (tab.agent != nil || (tab.agentPaneCount ?? 0) > 0) &&
                (needle.isEmpty || "\(computer.host.name) \(group.label) \(tab.displayTitle) \(tab.agent ?? "")".localizedCaseInsensitiveContains(needle))
            }
            guard !children.isEmpty else { continue }
            let key = Self.projectKey(group.label)
            let mapped = children.map { Child(workspaceID: group.id, workspaceLabel: group.label, tab: $0) }
            if var existing = merged[key] {
                existing.children.append(contentsOf: mapped)
                merged[key] = existing
            } else {
                merged[key] = (label: group.label, children: mapped)
                order.append(key)
            }
        }
        return order.compactMap { key in
            guard let entry = merged[key] else { return nil }
            return MatchingGroup(id: key, label: entry.label, children: entry.children)
        }
    }

    /// Workspaces that name the same project, ignoring case and surrounding
    /// space, read as one.
    private static func projectKey(_ label: String) -> String {
        label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct AgentDrawer: View {
    let current: LiveAgentSession?
    var panes: [AgentChatPanes.Pane] = []
    var selectedPaneID: String? = nil
    var choosePane: ((AgentChatPanes.Pane) -> Void)? = nil
    let chooseSession: (LiveAgentSession) -> Void
    let close: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How far the panel has been dragged left; 0 while it rests open.
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        // Only the panel's background runs to the screen edges; its
        // content keeps clear of the status bar and home indicator.
        ChatAgentSwitcher(session: current, panes: panes, selectedPaneID: selectedPaneID,
                          choosePane: { choosePane?($0); close() },
                          chooseSession: { chooseSession($0); close() }, close: close)
            .frame(width: min(UIScreen.main.bounds.width * 0.86, 380))
            .background(PhrenTheme.chatCanvas.ignoresSafeArea(edges: .vertical)).phrenElevation()
            .offset(x: dragOffset)
            .transition(.move(edge: .leading))
            // A leftward drag slides the panel away, like a standard side
            // drawer; vertical drags stay with the list inside it.
            .simultaneousGesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        guard abs(value.translation.width) > abs(value.translation.height) else { return }
                        dragOffset = min(0, value.translation.width)
                    }
                    .onEnded { value in
                        let horizontal = abs(value.translation.width) > abs(value.translation.height)
                        if horizontal, value.translation.width < -80 || value.predictedEndTranslation.width < -160 {
                            close()
                        } else if dragOffset != 0 {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { dragOffset = 0 }
                        }
                    }
            )
            // A marker names the drawer; an identifier on the container would
            // be stamped onto every child and hide the search field's own.
            .overlay(alignment: .topLeading) {
                Color.clear.frame(width: 1, height: 1).accessibilityElement()
                    .accessibilityLabel("Agents drawer").accessibilityIdentifier("agent-drawer")
            }
    }
}
