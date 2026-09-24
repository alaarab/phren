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
    @State private var branchWidths = CGSize.zero

    private var selectedPane: AgentChatPanes.Pane? { model.panes.first { $0.id == model.target?.paneID } }

    /// Where this conversation lives, in the terms the person thinks in:
    /// the project, then the model answering and the branch it is on. The
    /// computer is already the session list's business.
    private var chatLocation: String {
        [chatLocationProject, modelName, model.branch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The project part of the location line, drawn in the project's own color.
    private var chatLocationProject: String {
        session.usesFolderFallback(mappedProject: project?.name)
            ? "~/\(session.projectDisplayName(nil))" : session.projectDisplayName(project?.name)
    }

    private var modelName: String? {
        model.modelName.map { name in name.hasPrefix("claude-") ? String(name.dropFirst("claude-".count)) : name }
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
                    // A long title keeps both ends: how it starts and how it ends.
                    Text(selectedPane?.displayTitle ?? session.projectDisplayName(project?.name))
                        .foregroundStyle(selectedPane == nil && project != nil
                                         ? PhrenTheme.projectColor(storeId: project!.storeID, project: project!.name)
                                         : PhrenTheme.chatText)
                        .font(PhrenTypography.subheadline.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                        .accessibilityIdentifier("chat-title")
                    ChatLocationLine(project: chatLocationProject, projectColor: chatLocationColor,
                                     folder: session.usesFolderFallback(mappedProject: project?.name),
                                     model: modelName, branch: model.branch, branchWidths: $branchWidths)
                        .accessibilityElement(children: .combine)
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
        // A solid band of the chat canvas from the top of the screen to just
        // below the capsule; the transcript under it starts with a fade
        // (ChatHeaderFade), so no line shows beside or above the title.
        .background(alignment: .top) {
            PhrenTheme.chatCanvas.ignoresSafeArea(edges: .top)
        }
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement()
                .accessibilityIdentifier("chat-header")
        }
        #if DEBUG && targetEnvironment(simulator)
        .overlay(alignment: .bottomLeading) {
            // What the location line gave the branch, for the UI tests.
            if AgentChatFixture.enabled, model.branch != nil {
                Text("branch \(Int(branchWidths.width.rounded())) of \(Int(branchWidths.height.rounded()))")
                    .font(.system(size: 1)).frame(width: 1, height: 1).opacity(0.01)
                    .accessibilityIdentifier("chat-location-branch-width")
            }
        }
        #endif
    }
}

/// Below the header, the canvas fades out over the transcript, so a row
/// passing under the header dissolves instead of being cut off at an edge.
struct ChatHeaderFade: View {
    static let height: CGFloat = 16
    var body: some View {
        LinearGradient(colors: [PhrenTheme.chatCanvas, PhrenTheme.chatCanvas.opacity(0)], startPoint: .top, endPoint: .bottom)
            .frame(height: Self.height).allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// The project, model and branch on one line. Each part truncates on its own:
/// when they do not fit, the widest part gives up width first, so a long
/// project name can never push the branch off the line.
private struct ChatLocationLine: View {
    let project: String
    let projectColor: Color
    let folder: Bool
    let model: String?
    let branch: String?
    /// The branch's drawn and natural widths, reported for the UI tests.
    var branchWidths: Binding<CGSize>? = nil

    var body: some View {
        ChatLocationLayout {
            HStack(spacing: 3) {
                if folder { Image(systemName: "folder").font(.caption2) }
                Text(project).lineLimit(1).truncationMode(.middle)
            }.foregroundStyle(projectColor)
            if let model, !model.isEmpty {
                separator
                Text(model).lineLimit(1).truncationMode(.tail).foregroundStyle(PhrenTheme.chatNeutral)
            }
            if let branch, !branch.isEmpty {
                separator
                HStack(spacing: 3) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .semibold))
                    Text(branch).lineLimit(1).truncationMode(.middle)
                }
                .foregroundStyle(PhrenTheme.chatBranch)
                #if DEBUG && targetEnvironment(simulator)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { branchWidths?.wrappedValue.width = $0 }
                .background {
                    if AgentChatFixture.enabled {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .semibold))
                            Text(branch)
                        }
                        .fixedSize().hidden()
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { branchWidths?.wrappedValue.height = $0 }
                    }
                }
                #endif
            }
        }
        .font(PhrenTypography.caption2)
    }

    private var separator: some View {
        Text(" · ").foregroundStyle(PhrenTheme.chatNeutralDim).layoutPriority(1)
    }
}

/// One line of parts. A part with layout priority keeps its width (the
/// separators); the rest share what is left, the narrowest first, so each
/// keeps up to an equal share of the line.
private struct ChatLocationLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let widths = widths(proposal.width, subviews)
        let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
        return CGSize(width: widths.reduce(0, +), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        for (subview, width) in zip(subviews, widths(bounds.width, subviews)) {
            subview.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading,
                          proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width
        }
    }

    private func widths(_ available: CGFloat?, _ subviews: Subviews) -> [CGFloat] {
        let ideal = subviews.map { $0.sizeThatFits(.unspecified).width }
        guard let available, ideal.reduce(0, +) > available else { return ideal }
        var result = ideal
        var remaining = available - subviews.indices.filter { subviews[$0].priority > 0 }.map { ideal[$0] }.reduce(0, +)
        var flexible = subviews.indices.filter { subviews[$0].priority <= 0 }.sorted { ideal[$0] < ideal[$1] }
        while !flexible.isEmpty {
            let index = flexible.removeFirst()
            result[index] = max(0, min(ideal[index], remaining / CGFloat(flexible.count + 1)))
            remaining -= result[index]
        }
        return result
    }
}
