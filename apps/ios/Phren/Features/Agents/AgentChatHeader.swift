import PhrenKit
import PhrenLive
import SwiftUI

/// The chat's title bar: back, the agent's glyph and live state, the pane or
/// project title with where the conversation lives, and the options button.
struct AgentChatHeader: View {
    let session: LiveAgentSession
    let model: AgentChatModel
    let project: SessionProject?
    let active: Bool
    let showOptions: () -> Void

    private var selectedPane: AgentChatPanes.Pane? { model.panes.first { $0.id == model.target?.paneID } }

    /// Where this conversation lives, in the terms the person thinks in:
    /// the project, then the model answering and the branch it is on. The
    /// computer is already the session list's business.
    private var chatLocation: String {
        [chatLocationProject, chatLocationTail].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The project part of the location line, drawn in the project's own colour.
    private var chatLocationProject: String {
        session.usesFolderFallback(mappedProject: project?.name)
            ? "~/\(session.projectDisplayName(nil))" : session.projectDisplayName(project?.name)
    }

    /// The model and branch after the project name.
    private var chatLocationTail: String {
        let modelName = model.modelName.map { name in
            name.hasPrefix("claude-") ? String(name.dropFirst("claude-".count)) : name
        }
        return [modelName, model.branch].compactMap { $0 }.joined(separator: " · ")
    }

    private var chatLocationColor: Color {
        guard !session.usesFolderFallback(mappedProject: project?.name), let project = project else { return PhrenTheme.chatNeutral }
        return PhrenTheme.projectColor(storeId: project.storeID, project: project.name)
    }

    /// The computer and workspace left the visible line; VoiceOver still
    /// says them, ahead of the project the workspace resolved to.
    private var chatLocationSpoken: String {
        var parts = [session.host.name]
        if project != nil { parts.append(session.workspaceName) }
        parts.append(chatLocation)
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 10) {
            ChatDismissButton()
            Group {
                if session.tab.isConductor {
                    Image(systemName: "wand.and.rays")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(PhrenTheme.accent)
                        .accessibilityLabel("Conductor")
                        .accessibilityIdentifier("chat-conductor-mark")
                } else {
                    AgentProviderGlyph(source: model.target?.source, size: 22)
                }
            }
                .frame(width: 22, height: 22)
                .overlay(alignment: .bottomTrailing) {
                    ChatActivityIndicator(connected: model.connected && active,
                                          reconnecting: active && model.target != nil && !model.connected && !model.loading && !model.automaticReconnectSuspended,
                                          waiting: model.awaitingReply, revealing: model.reveal.isRevealing,
                                          needsAnswer: model.needsAnswer || model.approval != nil,
                                          compacting: model.isCompacting,
                                          phase: model.activityPhase)
                        .padding(1).background(PhrenTheme.chatPanel, in: Circle())
                        .offset(x: 4, y: 4)
                }
                .accessibilityElement(children: .contain)
            VStack(alignment: .leading, spacing: 2) {
                if session.tab.isConductor {
                    // The conductor works in the phren store, not a project:
                    // its name is the whole title, and there is no path to show.
                    Text("Conductor").foregroundStyle(PhrenTheme.accent)
                        .font(PhrenTypography.subheadline.weight(.semibold)).lineLimit(1)
                } else {
                    Text(selectedPane?.displayTitle ?? session.projectDisplayName(project?.name))
                        .foregroundStyle(selectedPane == nil && project != nil
                                         ? PhrenTheme.projectColor(storeId: project!.storeID, project: project!.name)
                                         : PhrenTheme.chatText)
                        .font(PhrenTypography.subheadline.weight(.semibold)).lineLimit(1)
                    HStack(spacing: 4) {
                        if session.usesFolderFallback(mappedProject: project?.name) { Image(systemName: "folder").font(.caption2) }
                        // The path keeps its width; the model and branch truncate first.
                        Text(chatLocationProject).foregroundStyle(chatLocationColor).lineLimit(1).layoutPriority(1)
                        if !chatLocationTail.isEmpty { Text(" · " + chatLocationTail).lineLimit(1) }
                    }
                        .font(PhrenTypography.caption2).foregroundStyle(PhrenTheme.chatNeutral)
                        .accessibilityLabel(chatLocationSpoken).accessibilityIdentifier("chat-location")
                }
            }.frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
            // Grants, repository changes and project linking live in the
            // options sheet: on a phone the title and location need the width.
            Button(action: showOptions) { Image(systemName: "ellipsis").frame(width: 36, height: 44).contentShape(Rectangle()) }
                .accessibilityLabel("Chat options").accessibilityIdentifier("chat-options")
        }
        .buttonStyle(.plain).foregroundStyle(PhrenTheme.chatText)
        .padding(.horizontal, 10).frame(minHeight: 48)
        .phrenPanel(radius: PhrenTheme.Radius.large)
        .padding(.horizontal, 10).padding(.top, PhrenDensity.chatHeaderTop).padding(.bottom, 4)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .accessibilityElement(children: .contain)
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement()
                .accessibilityIdentifier("chat-header")
        }
    }
}
