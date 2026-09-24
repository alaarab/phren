import PhrenKit
import PhrenLive
import SwiftUI

struct AgentChangesView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    var child: String? = nil
    /// One of the repository's other worktrees (a worker's checkout), by the
    /// id `/v1/git/worktrees` listed, and what the Workers row called it.
    var worktree: String? = nil
    var worktreeTitle: String? = nil
    var codeOrigin: SessionCodeContext? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @AppStorage("changes.wrap") private var wrapLines = true
    @AppStorage("changes.mode") private var mode = "list"
    @State private var model: ChangesModel
    @State private var selection: ChangesSection = .changes
    @State private var loadTask: Task<Void, Never>?
    @State private var visible = false
    @State private var indexedCode: SessionCodeContext?

    init(session: LiveAgentSession, target: AgentChatTarget, child: String? = nil, worktree: String? = nil,
         worktreeTitle: String? = nil, codeOrigin: SessionCodeContext? = nil) {
        self.session = session
        self.target = target
        self.child = child
        self.worktree = worktree
        self.worktreeTitle = worktreeTitle
        self.codeOrigin = codeOrigin
        _model = State(initialValue: ChangesModel(session: session, target: target, child: child, worktree: worktree))
    }

    /// Workers only list from the pane's own tree; a worker's view is already one.
    private var showsWorkers: Bool { child == nil && worktree == nil }

    private var changesEnabled: Bool {
        SessionOverviewMonitor.shared.allows(.changes, on: session.host, fallback: session.capabilities)
    }

    private var active: Bool {
        changesEnabled && visible && scenePhase == .active
            && preferencesStore.preferences?.hosts
                .first(where: { $0.id == session.host.id })?.hasSameConnection(as: session.host) == true
    }

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Rectangle().fill(PhrenTheme.border).frame(height: 0.5)
            selectedSection
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(PhrenTheme.chatCanvas)
        .environment(model)
        // A marker for "the Changes screen is up", kept in the body rather
        // than the toolbar so its element stays reachable.
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("changes-header")
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .presentationDragIndicator(.visible)
        .toolbar {
            // The branch and its counts ride in the top bar beside the back
            // chevron, so the content starts right under the section band.
            ToolbarItem(placement: .principal) { titleBar }
            ToolbarItem(placement: .topBarTrailing) {
                Button { wrapLines.toggle() } label: {
                    Image(systemName: "text.alignleft")
                        .font(PhrenTheme.Font.body.weight(.medium))
                        .foregroundStyle(wrapLines ? PhrenTheme.accent : PhrenTheme.textMuted)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(wrapLines ? "Unwrap long lines" : "Wrap long lines")
                .accessibilityIdentifier("changes-wrap-toggle")
            }
        }
        // Full height inside a tab: the tab bar would otherwise sit under the
        // last rows each section scrolls.
        .toolbar(.hidden, for: .tabBar)
        .task(id: codeOrigin?.id) {
            indexedCode = nil
            guard child == nil, worktree == nil, let origin = codeOrigin, await origin.hasIndex(), !Task.isCancelled else { return }
            indexedCode = origin
        }
        .onAppear { visible = true; if !changesEnabled { dismiss() }; scheduleLoad() }
        .onDisappear { visible = false; loadTask?.cancel() }
        .onChange(of: scenePhase) { _, _ in scheduleLoad() }
        .onChange(of: changesEnabled) { _, enabled in if !enabled { loadTask?.cancel(); dismiss() } }
        .onChange(of: model.revision) { _, _ in scheduleLoad() }
    }

    private func scheduleLoad() {
        loadTask?.cancel()
        guard active else { return }
        loadTask = Task { await model.load() }
        model.loadPullsOnce()
    }

    /// The top bar's two lines: the branch in body weight, the counts in
    /// caption underneath.
    private var titleBar: some View {
        VStack(spacing: 0) {
            Text(title)
                .font(PhrenTheme.Font.body.weight(.medium))
                .foregroundStyle(PhrenTheme.text)
                .lineLimit(1)
                .accessibilityIdentifier("changes-title")
            statusLine
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var title: String {
        if worktree != nil, let worktreeTitle, !worktreeTitle.isEmpty { return worktreeTitle }
        if child != nil || worktree != nil, let branch = model.status?.branch, !branch.isEmpty { return branch }
        return "Uncommitted changes"
    }

    @ViewBuilder private var statusLine: some View {
        if let status = model.status {
            let branch = status.branch.flatMap { $0.isEmpty ? nil : $0 } ?? "No branch"
            let files = Set(status.files.map(\.path)).count
            let spoken = "\(branch) · \(status.unstaged) unstaged · \(status.untracked) untracked · \(files) +\(status.additions) -\(status.deletions)"
            Group {
                if dynamicTypeSize > .large {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(branch).lineLimit(1).truncationMode(.tail)
                        statusCounts(status, files: files)
                    }
                } else {
                    HStack(spacing: 4) {
                        Text(branch).lineLimit(1).truncationMode(.tail)
                        separator
                        statusCounts(status, files: files)
                            .fixedSize(horizontal: true, vertical: false)
                            .layoutPriority(1)
                    }
                }
            }
            .font(PhrenTheme.Font.monoCaption)
            .foregroundStyle(PhrenTheme.textMuted)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken)
            .accessibilityIdentifier("changes-status-line")
        } else if let error = model.error {
            Text(error)
                .font(PhrenTheme.Font.monoCaption)
                .foregroundStyle(PhrenTheme.warning)
                .lineLimit(1)
                .accessibilityIdentifier("changes-status-error")
        } else {
            Text("Loading…")
                .font(PhrenTypography.monoCaption)
                .foregroundStyle(PhrenTheme.textMuted)
                .accessibilityIdentifier("changes-status-line")
        }
    }

    private func statusCounts(_ status: GitStatus, files: Int) -> some View {
        (Text("\(status.unstaged) unstaged · \(status.untracked) untracked · \(files) ")
            + Text("+\(status.additions)").foregroundColor(PhrenTheme.success)
            + Text(" ")
            + Text("-\(status.deletions)").foregroundColor(PhrenTheme.danger))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .truncationMode(.middle)
    }

    private var separator: some View { Text("·").foregroundStyle(PhrenTheme.textDim) }

    /// One 40pt band: the five section icons on the left, the Changes tab's
    /// List/Diff toggle on the right. The toggle only means something while
    /// Changes is showing.
    private var tabBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(ChangesSection.allCases.filter { ($0 != .code || indexedCode != nil) && ($0 != .workers || showsWorkers) }) { section in
                    Button { selection = section } label: {
                        Image(systemName: section.symbol)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(selection == section ? PhrenTheme.accent : PhrenTheme.textMuted)
                            .frame(maxWidth: .infinity, minHeight: PhrenDensity.changesIconTabHeight)
                            .background {
                                if selection == section {
                                    RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous)
                                        .fill(PhrenTheme.surface)
                                }
                            }
                            .contentShape(Rectangle().inset(by: -4))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(section.title)
                    .accessibilityIdentifier(section.accessibilityIdentifier)
                    .accessibilityAddTraits(selection == section ? [.isSelected] : [])
                }
            }
            .frame(maxWidth: .infinity)
            .padding(2)
            .overlay {
                Color.clear.frame(maxWidth: .infinity, minHeight: PhrenDensity.changesIconTabHeight).accessibilityElement()
                    .accessibilityIdentifier("changes-tab-bar")
                    .allowsHitTesting(false)
            }
            if selection == .changes { modeToggle }
        }
        .frame(minHeight: PhrenDensity.changesBandHeight)
        .padding(.horizontal, 10)
    }

    private var modeToggle: some View {
        HStack(spacing: 4) {
            modePill("List", icon: "list.bullet", value: "list", identifier: "changes-mode-list")
            modePill("Diff", icon: "rectangle.split.2x1", value: "diff", identifier: "changes-mode-diff")
        }
        .padding(2)
        .background(PhrenTheme.surface, in: Capsule())
    }

    private func modePill(_ title: String, icon: String, value: String, identifier: String) -> some View {
        let selected = mode == value
        return Button {
            guard mode != value else { return }
            mode = value
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon).font(PhrenTheme.Font.caption.weight(.semibold))
                Text(title).font(PhrenTheme.Font.subheadline.weight(.medium))
            }
            .foregroundStyle(selected ? PhrenTheme.accent : PhrenTheme.textMuted)
            .padding(.horizontal, 14).frame(minHeight: 32)
            .background(selected ? PhrenTheme.accent.opacity(0.16) : .clear, in: Capsule())
            .contentShape(Rectangle().inset(by: -6))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder private var selectedSection: some View {
        switch selection {
        case .changes: ChangesTab(session: session, target: target, child: child, worktree: worktree)
        case .history: ChangesHistoryTab(session: session, target: target, child: child, worktree: worktree)
        case .branches: ChangesBranchesTab(session: session, target: target, child: child, worktree: worktree)
        case .pulls: ChangesPullRequestsTab(session: session, target: target, child: child, worktree: worktree)
        case .tree: ChangesWorkingTreeTab(session: session, target: target, child: child, worktree: worktree, codeOrigin: indexedCode)
        case .workers: ChangesWorkersTab(session: session, target: target)
        case .code:
            if let origin = indexedCode { CodeView(storeId: origin.storeID, project: origin.project, origin: origin) }
        }
    }
}

enum ChangesSection: String, CaseIterable, Identifiable {
    case changes, history, branches, pulls, tree, workers, code

    var id: String { rawValue }
    var title: String {
        switch self {
        case .changes: "Changes"
        case .history: "History"
        case .branches: "Branches"
        case .pulls: "PRs"
        case .tree: "Working tree"
        case .workers: "Workers"
        case .code: "Code"
        }
    }
    var symbol: String {
        switch self {
        case .changes: "chevron.left.forwardslash.chevron.right"
        case .history: "clock.arrow.circlepath"
        case .branches: "arrow.triangle.branch"
        case .pulls: "arrow.triangle.pull"
        case .tree: "list.bullet.indent"
        case .workers: "person.2"
        case .code: "curlybraces"
        }
    }
    var accessibilityIdentifier: String { "changes-tab-\(rawValue)" }
}

/// One fetch keeps the header and file actions on the same status snapshot.
@Observable @MainActor
final class ChangesModel {
    let workingTree = WorkingTreeState()
    /// The commit draft and publish actions, kept across section switches.
    let publish = ChangesPublishModel()
    private(set) var status: GitStatus?
    private(set) var error: String?
    /// Bumped by `reload()`; the container observes it and starts a fetch.
    private(set) var revision = 0

    let session: LiveAgentSession
    let target: AgentChatTarget
    let child: String?
    let worktree: String?
    /// The repository's other worktrees, for the Workers section.
    private(set) var worktrees: GitWorktrees?
    private(set) var worktreesError: String?

    init(session: LiveAgentSession, target: AgentChatTarget, child: String?, worktree: String? = nil) {
        self.session = session
        self.target = target
        self.child = child
        self.worktree = worktree
    }

    func loadWorktrees() async {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            do { worktrees = try AgentChatFixture.gitWorktrees(); worktreesError = nil }
            catch { worktreesError = error.localizedDescription }
            return
        }
        #endif
        do {
            let value = try await PhrenConnection.gitWorktrees(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target)
            guard !Task.isCancelled else { return }
            worktrees = value; worktreesError = nil
        } catch {
            guard !Task.isCancelled else { return }
            worktreesError = error.localizedDescription
        }
    }

    func reload() { revision &+= 1 }

    /// The branch's pull requests: loaded when the screen opens, on pull to
    /// refresh, and after a push or a new pull request. The pane's own answer
    /// also feeds the session card.
    private(set) var pulls: GitPulls?
    @ObservationIgnored private var pullsRequested = false

    func loadPullsOnce() {
        guard !pullsRequested else { return }
        pullsRequested = true
        Task { await loadPulls() }
    }

    func loadPulls() async {
        do {
            let value: GitPulls
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { value = try AgentChatFixture.pulls() }
            else { value = try await PhrenConnection.gitPulls(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, worktree: worktree) }
            #else
            value = try await PhrenConnection.gitPulls(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, worktree: worktree)
            #endif
            recordPulls(value)
        } catch {
            // Optional: the PRs tab reports its own failure; the actions keep working.
        }
    }

    func recordPulls(_ value: GitPulls) {
        pulls = value
        if child == nil && worktree == nil { SessionPullRequestCache.shared.record(value, for: session) }
    }

    func load() async {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            do { status = try AgentChatFixture.gitStatus(target, child: child, worktree: worktree); error = nil }
            catch { self.error = error.localizedDescription }
            return
        }
        #endif
        do {
            let key = try DeviceSSHKey.load(session.host.id)
            let value = try await PhrenConnection.gitStatus(host: session.host, privateKey: key, target: target, child: child, worktree: worktree)
            guard !Task.isCancelled else { return }
            status = value
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}


@Observable @MainActor
final class WorkingTreeState {
    var tree: GitWorkingTree?
    var children: [String: GitWorkingTree] = [:]
    var expanded: Set<String> = []
    var summaries: [String: CodeOutlineSummary] = [:]
}
