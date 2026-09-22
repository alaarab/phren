import PhrenKit
import PhrenLive
import SwiftUI
import UIKit

struct ChangesHistoryTab: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    var child: String? = nil
    /// When pushed from Branches, the ref whose log to show.
    var ref: String? = nil

    @Environment(\.scenePhase) private var scenePhase
    @State private var log: GitLog?
    @State private var error: String?
    @State private var visible = false
    @State private var copied: String?
    @State private var showingFull: GitLog.Commit?
    @State private var commitDialog = false
    @State private var loadTask: Task<Void, Never>?

    private enum Row: Identifiable {
        case uncommitted(GitLog.Uncommitted)
        case commit(GitLog.Commit)
        var id: String {
            switch self {
            case .uncommitted: return "uncommitted"
            case .commit(let commit): return commit.sha
            }
        }
    }

    var body: some View {
        Group {
            if let log {
                PhrenScrollScreen(spacing: 0) {
                    if log.commits.isEmpty { empty }
                    let rows = [Row.uncommitted(log.uncommitted)] + log.commits.map(Row.commit)
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        content(row, top: index > 0, bottom: index < rows.count - 1)
                    }
                }
                .refreshable { await load() }
            } else if let error {
                errorState(error)
            } else {
                loading
            }
        }
        .accessibilityIdentifier("changes-history")
        .overlay(alignment: .bottom) { toast }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let ref {
                Text(ref).font(PhrenTheme.Font.title2.weight(.bold))
                    .foregroundStyle(PhrenTheme.text)
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(PhrenTheme.Space.large)
                    .background(PhrenTheme.bg)
                    .accessibilityIdentifier("changes-history-ref")
            }
        }
        .onAppear { visible = true; start() }
        .onDisappear { visible = false; loadTask?.cancel(); loadTask = nil }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, visible { start() } else if phase != .active { loadTask?.cancel() }
        }
        .phrenDialog(
            isPresented: $commitDialog,
            title: "Commit",
            message: showingFull.map { "\($0.sha)\n\($0.author)" } ?? "",
            actions: commitActions,
            identifier: "changes-history-commit-dialog"
        )
    }

    private var commitActions: [PhrenDialog.Action] {
        guard let commit = showingFull else {
            return [.init(id: "ok", title: "OK", role: .cancel) {}]
        }
        return [
            .init(id: "copy-short-sha", title: "Copy short sha") { copy(commit) },
            .init(id: "ok", title: "OK", role: .cancel) {},
        ]
    }

    @ViewBuilder
    private func content(_ row: Row, top: Bool, bottom: Bool) -> some View {
        switch row {
        case .uncommitted(let uncommitted):
            HStack(spacing: 8) {
                Text("Uncommitted changes").font(PhrenTypography.footnote.weight(.medium)).foregroundStyle(PhrenTheme.text).lineLimit(1)
                Spacer(minLength: 8)
                if uncommitted.files > 0 {
                    Text("\(uncommitted.files) file\(uncommitted.files == 1 ? "" : "s")")
                        .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).monospacedDigit()
                    PhrenStatLabel(added: uncommitted.additions, removed: uncommitted.deletions)
                }
            }
            .padding(.vertical, 2)
            .padding(.leading, 34)
            .frame(minHeight: 40)
            .background(uncommitted.files > 0 ? PhrenTheme.success.opacity(0.08) : Color.clear)
            .overlay(alignment: .leading) { HistoryRail(connectTop: false, connectBottom: bottom, ring: true) }
            .accessibilityIdentifier("changes-history-uncommitted")
        case .commit(let commit):
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(commit.subject).font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.chatText)
                        .lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 8)
                    Text(commit.relativeTime).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).monospacedDigit()
                }
                if !commit.refs.isEmpty { GitRefChips(refs: commit.refs) }
            }
            .padding(.vertical, 2)
            .padding(.leading, 34)
            .frame(minHeight: 40)
            .contentShape(Rectangle().inset(by: -2))
            .overlay(alignment: .leading) { HistoryRail(connectTop: top, connectBottom: bottom, ring: false) }
            .onTapGesture { copy(commit) }
            .onLongPressGesture { showingFull = commit; commitDialog = true }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("changes-history-commit:\(commit.short)")
        }
    }

    private var loading: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Reading the commit history…").font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PhrenTheme.bg)
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath").font(PhrenTheme.Font.title2).foregroundStyle(PhrenTheme.textMuted)
            Text("No commits yet").font(PhrenTheme.Font.subheadline).foregroundStyle(PhrenTheme.textMuted)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 60)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(PhrenTheme.Font.title2).foregroundStyle(PhrenTheme.warning)
            Text(message).font(PhrenTheme.Font.footnote).multilineTextAlignment(.center).foregroundStyle(PhrenTheme.textMuted)
            Button("Try again") { start() }.buttonStyle(.bordered)
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PhrenTheme.bg)
    }

    @ViewBuilder
    private var toast: some View {
        if let copied {
            Text("Copied \(copied)")
                .font(PhrenTheme.Font.footnote.weight(.medium)).foregroundStyle(PhrenTheme.text)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(PhrenTheme.surfaceRaised, in: Capsule())
                .overlay(Capsule().strokeBorder(PhrenTheme.borderStrong, lineWidth: 0.5))
                .padding(.bottom, 24)
                .accessibilityIdentifier("changes-history-toast")
        }
    }

    private func copy(_ commit: GitLog.Commit) {
        UIPasteboard.general.string = commit.short
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(.easeOut(duration: 0.15)) { copied = commit.short }
        let short = commit.short
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            if copied == short { withAnimation(.easeOut(duration: 0.2)) { copied = nil } }
        }
    }

    private func start() {
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    private func load() async {
        do {
            let value: GitLog
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { value = try AgentChatFixture.gitLog(target: target, ref: ref) }
            else { value = try await fetch() }
            #else
            value = try await fetch()
            #endif
            try Task.checkCancellation()
            log = value; error = nil
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func fetch() async throws -> GitLog {
        try await PhrenConnection.gitLog(host: session.host, privateKey: DeviceSSHKey.load(session.host.id),
                                         target: target, child: child, limit: 60, ref: ref)
    }
}

private struct HistoryRail: View {
    let connectTop: Bool
    let connectBottom: Bool
    let ring: Bool

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                segment(connectTop)
                segment(connectBottom)
            }
            Circle()
                .fill(ring ? PhrenTheme.bg : PhrenTheme.success)
                .overlay(Circle().strokeBorder(ring ? PhrenTheme.success : .clear, lineWidth: 2))
                .frame(width: 10, height: 10)
        }
        .frame(width: 24)
        .accessibilityHidden(true)
    }

    private func segment(_ on: Bool) -> some View {
        Rectangle().fill(on ? PhrenTheme.success.opacity(0.45) : .clear).frame(width: 2).frame(maxHeight: .infinity)
    }
}

private struct GitRefChips: View {
    let refs: [GitLog.Ref]

    var body: some View {
        GitChipFlow(spacing: 4) {
            ForEach(refs) { GitRefChip(ref: $0) }
        }
        .accessibilityHidden(true)
    }
}

private struct GitRefChip: View {
    let ref: GitLog.Ref

    private var primary: Bool { ref.kind == .head || (ref.kind == .local && ref.name == "main") }
    private var color: Color {
        switch ref.kind {
        case .head: return PhrenTheme.success
        case .remote: return PhrenTheme.warning
        case .local: return ref.name == "main" ? PhrenTheme.success : PhrenTheme.chatNeutral
        case .tag: return PhrenTheme.chatNeutralDim
        case .unknown: return PhrenTheme.chatNeutralDim
        }
    }
    private var symbol: String {
        if primary { return "circle.fill" }
        return ref.kind == .tag ? "tag" : "arrow.triangle.branch"
    }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(PhrenTheme.Font.caption2.weight(.semibold))
            Text(ref.name).font(PhrenTheme.Font.monoCaption2).lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(color.opacity(0.14), in: Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.3), lineWidth: 0.5))
    }
}

private struct GitChipFlow: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: maxWidth.isFinite ? maxWidth : nil, height: nil))
            if x > 0, x + size.width > maxWidth { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? max(0, x - spacing) : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
