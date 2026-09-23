import PhrenKit
import PhrenLive
import SwiftUI

struct ChangesPullRequestsTab: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let child: String?
    var worktree: String? = nil
    @Environment(\.openURL) private var openURL
    @State private var model: GitPulls?
    @State private var error: String?
    @State private var loadTask: Task<Void, Never>?

    init(session: LiveAgentSession, target: AgentChatTarget, child: String?, worktree: String? = nil) {
        self.session = session
        self.target = target
        self.child = child
        self.worktree = worktree
    }

    var body: some View {
        PhrenList(plain: true) {
            if let model {
                if !model.available {
                    message("GitHub CLI is not signed in on this computer",
                            detail: "Install it with brew install gh, then run gh auth login there.")
                } else if model.pulls.isEmpty {
                    message("No open pull requests", detail: nil)
                } else {
                    ForEach(model.pulls) { pull in
                        Button { open(pull) } label: { row(pull) }
                            .buttonStyle(.plain)
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                            .accessibilityIdentifier("changes-pull:\(pull.number)")
                    }
                }
            } else if let error {
                message("Pull requests are unavailable", detail: error)
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading pull requests…").foregroundStyle(PhrenTheme.textMuted)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .listRowBackground(Color.clear)
            }
        }
        .environment(\.defaultMinListRowHeight, 40)
        .accessibilityIdentifier("changes-pulls")
        .refreshable { await load() }
        .onAppear { if model == nil { reload() } }
        .onDisappear { loadTask?.cancel() }
    }

    @MainActor
    private func reload() {
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    @MainActor
    private func load() async {
        do {
            let result: GitPulls
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                result = try AgentChatFixture.pulls()
            } else {
                result = try await PhrenConnection.gitPulls(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, worktree: worktree)
            }
            #else
            result = try await PhrenConnection.gitPulls(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, child: child, worktree: worktree)
            #endif
            try Task.checkCancellation()
            model = result; error = nil
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func open(_ pull: GitPulls.Pull) {
        guard let url = URL(string: pull.url), url.scheme == "https" else { return }
        openURL(url)
    }

    private func row(_ pull: GitPulls.Pull) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(stateColor(pull)).frame(width: 8, height: 8).padding(.top, 5)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text("#\(pull.number)").font(PhrenTypography.monoFootnote).foregroundStyle(PhrenTheme.textMuted)
                    Text(pull.title).font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.text).lineLimit(1).truncationMode(.tail)
                }
                HStack(spacing: 4) {
                    chip(pull.head)
                    Image(systemName: "arrow.right").font(PhrenTheme.Font.caption2.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                    chip(pull.base)
                    Text(pull.author).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted)
                        .lineLimit(1).truncationMode(.tail).padding(.leading, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 40)
        .contentShape(Rectangle().inset(by: -2))
    }

    private func chip(_ text: String) -> some View {
        Text(text).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted)
            .lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(PhrenTheme.surfaceRaised, in: Capsule())
    }

    private func stateColor(_ pull: GitPulls.Pull) -> Color {
        if pull.draft { return PhrenTheme.textMuted }
        switch pull.state {
        case .open: return PhrenTheme.success
        case .merged: return PhrenTheme.violet
        case .closed: return PhrenTheme.danger
        case .unknown: return PhrenTheme.textMuted
        }
    }

    private func message(_ title: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(PhrenTheme.Font.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text)
            if let detail { Text(detail).font(PhrenTheme.Font.footnote).foregroundStyle(PhrenTheme.textMuted) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .listRowBackground(Color.clear)
    }
}
