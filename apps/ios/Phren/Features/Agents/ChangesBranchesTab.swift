import PhrenKit
import PhrenLive
import SwiftUI

struct ChangesBranchesTab: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    var child: String? = nil

    @Environment(\.scenePhase) private var scenePhase
    @State private var branches: GitBranches?
    @State private var error: String?
    @State private var visible = false
    @State private var loadTask: Task<Void, Never>?

    var body: some View {
        Group {
            if let branches {
                PhrenScrollScreen {
                    if branches.local.isEmpty && branches.remote.isEmpty { empty }
                    if !branches.local.isEmpty {
                        PhrenSectionHeader(title: "Local", count: branches.local.count)
                        ForEach(branches.local) { branch in
                            NavigationLink {
                                ChangesHistoryTab(session: session, target: target, child: child, ref: branch.name)
                            } label: {
                                BranchRow(name: branch.name, upstream: branch.upstream, tracking: branch.tracking,
                                          current: branch.name == branches.current, remote: false)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("changes-branches-branch:\(branch.name)")
                        }
                    }
                    if !branches.remote.isEmpty {
                        PhrenSectionHeader(title: "Remote", count: branches.remote.count)
                        ForEach(branches.remote) { branch in
                            BranchRow(name: branch.name, upstream: nil, tracking: nil, current: false, remote: true)
                                .accessibilityIdentifier("changes-branches-branch:\(branch.name)")
                        }
                    }
                }
                .refreshable { await load() }
            } else if let error {
                errorState(error)
            } else {
                loading
            }
        }
        .accessibilityIdentifier("changes-branches")
        .onAppear { visible = true; start() }
        .onDisappear { visible = false; loadTask?.cancel(); loadTask = nil }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, visible { start() } else if phase != .active { loadTask?.cancel() }
        }
    }

    private var loading: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Reading branches…").font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PhrenTheme.bg)
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.triangle.branch").font(PhrenTheme.Font.title2).foregroundStyle(PhrenTheme.textMuted)
            Text("No branches yet").font(PhrenTheme.Font.subheadline).foregroundStyle(PhrenTheme.textMuted)
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

    private func start() {
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    private func load() async {
        do {
            let value: GitBranches
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { value = try AgentChatFixture.gitBranches(target: target) }
            else { value = try await fetch() }
            #else
            value = try await fetch()
            #endif
            try Task.checkCancellation()
            branches = value; error = nil
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func fetch() async throws -> GitBranches {
        try await PhrenConnection.gitBranches(host: session.host, privateKey: DeviceSSHKey.load(session.host.id),
                                              target: target, child: child)
    }
}

private struct BranchRow: View {
    let name: String
    let upstream: String?
    let tracking: String?
    let current: Bool
    let remote: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: remote ? "cloud" : "arrow.triangle.branch")
                .font(PhrenTheme.Font.subheadline.weight(.semibold))
                .foregroundStyle(current ? PhrenTheme.success : PhrenTheme.chatNeutralDim)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name).font(PhrenTheme.Font.monoSubheadline.weight(.medium))
                        .foregroundStyle(current ? PhrenTheme.success : PhrenTheme.chatText)
                        .lineLimit(1).truncationMode(.middle)
                    if let upstream {
                        Text(upstream).font(PhrenTheme.Font.monoCaption)
                            .foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                    }
                }
                if let tracking {
                    Text(tracking).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).monospacedDigit()
                }
            }
            Spacer(minLength: 8)
            if !remote {
                Image(systemName: "arrow.up.right")
                    .font(PhrenTheme.Font.subheadline.weight(.semibold))
                    .foregroundStyle(PhrenTheme.textMuted)
                    .frame(width: 32, height: 44)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, PhrenTheme.Space.medium).padding(.vertical, 6)
        .frame(minHeight: 44)
        .background(current ? PhrenTheme.success.opacity(0.12) : PhrenTheme.surface,
                    in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
        .contentShape(Rectangle())
    }
}
