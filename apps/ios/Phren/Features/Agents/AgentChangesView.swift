import PhrenKit
import PhrenLive
import SwiftUI

struct AgentChangesView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    var child: String? = nil

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @AppStorage("changes.wrap") private var wrapLines = true
    @State private var model: ChangesModel
    @State private var selection: ChangesSection = .changes
    @State private var loadTask: Task<Void, Never>?
    @State private var visible = false

    init(session: LiveAgentSession, target: AgentChatTarget, child: String? = nil) {
        self.session = session
        self.target = target
        self.child = child
        _model = State(initialValue: ChangesModel(session: session, target: target, child: child))
    }

    private var active: Bool {
        visible && scenePhase == .active
            && (try? LiveSessionPreferences.read(hostData))?.hosts.first(where: { $0.id == session.host.id }) == session.host
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            tabBar
            Rectangle().fill(PhrenTheme.border).frame(height: 0.5)
            selectedSection
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(PhrenTheme.chatCanvas)
        .environment(model)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .presentationDragIndicator(.visible)
        .toolbar {
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
        .onAppear { visible = true; scheduleLoad() }
        .onDisappear { visible = false; loadTask?.cancel() }
        .onChange(of: scenePhase) { _, _ in scheduleLoad() }
        .onChange(of: model.revision) { _, _ in scheduleLoad() }
    }

    private func scheduleLoad() {
        loadTask?.cancel()
        guard active else { return }
        loadTask = Task { await model.load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(PhrenTheme.Font.title2.weight(.bold))
                .foregroundStyle(PhrenTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityIdentifier("changes-title")
            statusLine
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("changes-header")
        }
    }

    private var title: String {
        if child != nil, let branch = model.status?.branch, !branch.isEmpty { return branch }
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
            .font(PhrenTheme.Font.monoFootnote)
            .foregroundStyle(PhrenTheme.textMuted)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken)
            .accessibilityIdentifier("changes-status-line")
        } else if let error = model.error {
            Text(error)
                .font(PhrenTheme.Font.monoFootnote)
                .foregroundStyle(PhrenTheme.warning)
                .lineLimit(2)
                .accessibilityIdentifier("changes-status-error")
        } else {
            Text("Loading…")
                .font(PhrenTypography.monoFootnote)
                .foregroundStyle(PhrenTheme.textMuted)
                .accessibilityIdentifier("changes-status-line")
        }
    }

    private func statusCounts(_ status: GitStatus, files: Int) -> some View {
        (Text("\(status.unstaged) unstaged · \(status.untracked) untracked · \(files) ")
            + Text("+\(status.additions)").foregroundColor(PhrenTheme.success)
            + Text(" ")
            + Text("-\(status.deletions)").foregroundColor(PhrenTheme.danger))
            .fixedSize(horizontal: false, vertical: true)
    }

    private var separator: some View { Text("·").foregroundStyle(PhrenTheme.textDim) }

    private var tabBar: some View {
        HStack(spacing: 4) {
            ForEach(ChangesSection.allCases) { section in
                Button { selection = section } label: {
                    Image(systemName: section.symbol)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(selection == section ? PhrenTheme.accent : PhrenTheme.textMuted)
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .background {
                            if selection == section {
                                RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous)
                                    .fill(PhrenTheme.surface)
                            }
                        }
                        .contentShape(Rectangle().inset(by: -6))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(section.title)
                .accessibilityIdentifier(section.accessibilityIdentifier)
                .accessibilityAddTraits(selection == section ? [.isSelected] : [])
            }
        }
        .padding(2)
        .padding(.horizontal, 10)
        .overlay {
            Color.clear.frame(maxWidth: .infinity, minHeight: 36).accessibilityElement()
                .accessibilityIdentifier("changes-tab-bar")
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder private var selectedSection: some View {
        switch selection {
        case .changes: ChangesTab(session: session, target: target, child: child)
        case .history: ChangesHistoryTab(session: session, target: target, child: child)
        case .branches: ChangesBranchesTab(session: session, target: target, child: child)
        case .pulls: ChangesPullRequestsTab(session: session, target: target, child: child)
        case .tree: ChangesWorkingTreeTab(session: session, target: target, child: child)
        }
    }
}

enum ChangesSection: String, CaseIterable, Identifiable {
    case changes, history, branches, pulls, tree

    var id: String { rawValue }
    var title: String {
        switch self {
        case .changes: "Changes"
        case .history: "History"
        case .branches: "Branches"
        case .pulls: "PRs"
        case .tree: "Working tree"
        }
    }
    var symbol: String {
        switch self {
        case .changes: "chevron.left.forwardslash.chevron.right"
        case .history: "clock.arrow.circlepath"
        case .branches: "arrow.triangle.branch"
        case .pulls: "arrow.triangle.pull"
        case .tree: "list.bullet.indent"
        }
    }
    var accessibilityIdentifier: String { "changes-tab-\(rawValue)" }
}

/// One fetch keeps the header and file actions on the same status snapshot.
@Observable @MainActor
final class ChangesModel {
    private(set) var status: GitStatus?
    private(set) var error: String?
    /// Bumped by `reload()`; the container observes it and starts a fetch.
    private(set) var revision = 0

    let session: LiveAgentSession
    let target: AgentChatTarget
    let child: String?

    init(session: LiveAgentSession, target: AgentChatTarget, child: String?) {
        self.session = session
        self.target = target
        self.child = child
    }

    func reload() { revision &+= 1 }

    func load() async {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            do { status = try AgentChatFixture.gitStatus(target, child: child); error = nil }
            catch { self.error = error.localizedDescription }
            return
        }
        #endif
        do {
            let key = try DeviceSSHKey.load(session.host.id)
            let value = try await PhrenConnection.gitStatus(host: session.host, privateKey: key, target: target, child: child)
            guard !Task.isCancelled else { return }
            status = value
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}
