import PhrenKit
import PhrenLive
import SwiftUI

/// The repository's other worktrees, where workers (sub-agents, fan-out jobs)
/// keep their edits. The pane's own diff never shows that work, so each row
/// opens the same Changes screen bound to that worktree. A worker the
/// computer can name leads; unlabelled worktrees follow.
struct ChangesWorkersTab: View {
    let session: LiveAgentSession
    let target: AgentChatTarget

    @Environment(ChangesModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false

    var body: some View {
        Group {
            if let list = model.worktrees {
                let workers = list.worktrees.filter { $0.worker != nil }
                let others = list.worktrees.filter { $0.worker == nil }
                PhrenScrollScreen {
                    if list.worktrees.isEmpty { empty }
                    if !workers.isEmpty {
                        PhrenSectionHeader(title: "Workers", count: workers.count)
                            .accessibilityIdentifier("changes-workers-section:workers")
                        ForEach(workers) { row($0) }
                    }
                    if !others.isEmpty {
                        PhrenSectionHeader(title: workers.isEmpty ? "Worktrees" : "Other worktrees", count: others.count)
                            .accessibilityIdentifier("changes-workers-section:other")
                        ForEach(others) { row($0) }
                    }
                }
                .refreshable { await model.loadWorktrees() }
            } else if let error = model.worktreesError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle").font(PhrenTheme.Font.title2).foregroundStyle(PhrenTheme.warning)
                    Text(error).font(PhrenTheme.Font.footnote).multilineTextAlignment(.center).foregroundStyle(PhrenTheme.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity).padding(24)
                .accessibilityIdentifier("changes-workers-error")
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Reading worktrees…").font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(PhrenTheme.bg)
        .accessibilityIdentifier("changes-workers")
        .onAppear { visible = true; Task { await model.loadWorktrees() } }
        .onDisappear { visible = false }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, visible { Task { await model.loadWorktrees() } }
        }
    }

    private func row(_ worktree: GitWorktrees.Worktree) -> some View {
        NavigationLink {
            AgentChangesView(session: session, target: target, worktree: worktree.id, worktreeTitle: worktree.title)
        } label: {
            WorktreeRow(worktree: worktree)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("changes-worktree:\(worktree.id)")
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "person.2").font(PhrenTheme.Font.title2).foregroundStyle(PhrenTheme.textMuted)
            Text("No other worktrees").font(PhrenTheme.Font.subheadline).foregroundStyle(PhrenTheme.textMuted)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 60)
        .accessibilityIdentifier("changes-workers-empty")
    }
}

/// One worktree: the worker's task (or the branch), then branch and folder,
/// with uncommitted files and commits ahead trailing.
private struct WorktreeRow: View {
    let worktree: GitWorktrees.Worktree
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var detail: String {
        // A worker's row names its branch; the folder is the detail of a
        // worktree nobody claims.
        if worktree.main { return (worktree.branch ?? "detached") + " · main checkout" }
        if worktree.worker != nil { return worktree.branch ?? "detached" }
        return worktree.branch == nil ? "detached · " + worktree.path : worktree.path
    }

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if let provider = worktree.worker?.provider {
                    AgentProviderGlyph(source: provider, size: 20)
                } else {
                    Image(systemName: "arrow.triangle.branch")
                        .font(PhrenTheme.Font.subheadline.weight(.semibold))
                        .foregroundStyle(PhrenTheme.chatNeutralDim)
                }
            }
            .frame(width: 22)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(worktree.title)
                    .font(PhrenTheme.Font.subheadline.weight(.medium))
                    .foregroundStyle(PhrenTheme.chatText)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                Text(detail)
                    .font(PhrenTheme.Font.monoCaption)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(1).truncationMode(.middle)
                if dynamicTypeSize.isAccessibilitySize, let summary = worktree.summary { counts(summary) }
            }
            Spacer(minLength: 8)
            if !dynamicTypeSize.isAccessibilitySize, let summary = worktree.summary { counts(summary) }
            Image(systemName: "chevron.right")
                .font(PhrenTheme.Font.caption.weight(.semibold))
                .foregroundStyle(PhrenTheme.textDim)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, PhrenTheme.Space.medium).padding(.vertical, 8)
        .frame(minHeight: 44)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func counts(_ summary: String) -> some View {
        Text(summary)
            .font(PhrenTheme.Font.monoCaption)
            .foregroundStyle(worktree.changed > 0 ? PhrenTheme.warning : PhrenTheme.textMuted)
            .monospacedDigit()
            .fixedSize()
    }
}
