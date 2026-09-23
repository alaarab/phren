import PhrenKit
import PhrenLive
import SwiftUI

/// Finishing a session from Changes: a commit composer over the staged files,
/// then Push and Open pull request. Push and the pull request confirm first in
/// a phren dialog; Git's and gh's refusals are shown exactly as printed.
@Observable @MainActor
final class ChangesPublishModel {
    enum Action: Equatable { case commit, push, pullRequest }
    struct Notice: Identifiable {
        let id = UUID()
        let title: String
        let message: String
        var url: URL? = nil
        var identifier = "changes-publish-dialog"
    }

    var message = ""
    private(set) var busy: Action?
    var confirmingPush = false
    var confirmingPullRequest = false
    var notice: Notice?
    /// One quiet line under the actions after a commit or push lands.
    private(set) var landed: String?

    func commit(_ changes: ChangesModel) {
        guard busy == nil else { return }
        let text = message
        busy = .commit
        Task {
            defer { busy = nil }
            do {
                let result: GitPublishResult
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { result = try AgentChatFixture.gitCommit(message: text) }
                else { result = try await Self.commit(changes, message: text) }
                #else
                result = try await Self.commit(changes, message: text)
                #endif
                if result.ok {
                    message = ""
                    landed = "Committed \(result.short ?? "") \(result.subject ?? "")".trimmingCharacters(in: .whitespaces)
                } else {
                    notice = Notice(title: "The commit was refused", message: result.failureText, identifier: "changes-commit-refused")
                }
                changes.reload()
            } catch {
                notice = Notice(title: "Could not commit", message: error.localizedDescription, identifier: "changes-commit-refused")
            }
        }
    }

    func push(_ changes: ChangesModel, confirmDefault: Bool) {
        guard busy == nil else { return }
        busy = .push
        Task {
            defer { busy = nil }
            do {
                let result: GitPublishResult
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { result = try AgentChatFixture.gitPush(confirmDefault: confirmDefault) }
                else { result = try await Self.push(changes, confirmDefault: confirmDefault) }
                #else
                result = try await Self.push(changes, confirmDefault: confirmDefault)
                #endif
                if result.ok {
                    landed = "Pushed to \(result.upstream ?? "origin")"
                } else {
                    notice = Notice(title: "The push was refused", message: result.failureText, identifier: "changes-push-refused")
                }
                changes.reload()
                await changes.loadPulls()
            } catch {
                notice = Notice(title: "Could not push", message: error.localizedDescription, identifier: "changes-push-refused")
            }
        }
    }

    func openPullRequest(_ changes: ChangesModel, draft: Bool) {
        guard busy == nil else { return }
        busy = .pullRequest
        Task {
            defer { busy = nil }
            do {
                let result: GitPublishResult
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { result = try AgentChatFixture.gitPullRequest(draft: draft) }
                else { result = try await Self.pullRequest(changes, draft: draft) }
                #else
                result = try await Self.pullRequest(changes, draft: draft)
                #endif
                if result.ok, let url = result.pullURL {
                    notice = Notice(title: result.existing == true ? "This branch already has a pull request" : "Pull request opened",
                                    message: url.absoluteString, url: url, identifier: "changes-pr-opened")
                    await changes.loadPulls()
                } else {
                    notice = Notice(title: "Could not open a pull request", message: result.failureText, identifier: "changes-pr-refused")
                }
            } catch {
                notice = Notice(title: "Could not open a pull request", message: error.localizedDescription, identifier: "changes-pr-refused")
            }
        }
    }

    private static func commit(_ changes: ChangesModel, message: String) async throws -> GitPublishResult {
        try await PhrenConnection.gitCommit(host: changes.session.host, privateKey: DeviceSSHKey.load(changes.session.host.id),
                                            target: changes.target, child: changes.child, worktree: changes.worktree, message: message)
    }

    private static func push(_ changes: ChangesModel, confirmDefault: Bool) async throws -> GitPublishResult {
        try await PhrenConnection.gitPush(host: changes.session.host, privateKey: DeviceSSHKey.load(changes.session.host.id),
                                          target: changes.target, child: changes.child, worktree: changes.worktree,
                                          confirmDefault: confirmDefault)
    }

    private static func pullRequest(_ changes: ChangesModel, draft: Bool) async throws -> GitPublishResult {
        try await PhrenConnection.gitPullRequest(host: changes.session.host, privateKey: DeviceSSHKey.load(changes.session.host.id),
                                                 target: changes.target, child: changes.child, worktree: changes.worktree, draft: draft)
    }
}

struct ChangesPublishPanel: View {
    let status: GitStatus
    @Bindable var publish: ChangesPublishModel
    @Environment(ChangesModel.self) private var changes
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var branch: String { status.branch ?? "" }
    /// This branch's own pull request, when the pulls data has one.
    private var existingPull: GitPulls.Current? {
        guard let current = changes.pulls?.current, current.head == branch else { return nil }
        return current
    }
    private var canCommit: Bool {
        publish.busy == nil && status.staged > 0 && !publish.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var canPush: Bool { publish.busy == nil && !branch.isEmpty && (status.upstream == nil || status.ahead > 0) }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            HStack(alignment: .bottom, spacing: PhrenTheme.Space.small) {
                PhrenTextField(status.staged > 0 ? "Commit message" : "Stage files to commit", text: $publish.message,
                               identifier: "changes-commit-message", axis: .vertical)
                    .lineLimit(1...4)
                    .disabled(publish.busy != nil)
                actionButton("Commit", icon: "checkmark", prominent: true, busy: publish.busy == .commit,
                             enabled: canCommit, identifier: "changes-commit") { publish.commit(changes) }
                    .accessibilityHint(status.staged > 0 ? "Commits the \(status.staged) staged files" : "Stage files first")
            }
            let actions = Group {
                actionButton(pushTitle, icon: "arrow.up", busy: publish.busy == .push, enabled: canPush,
                             identifier: "changes-push") { publish.confirmingPush = true }
                if let pull = existingPull {
                    actionButton("Pull request #\(pull.number)", icon: "arrow.triangle.pull", enabled: publish.busy == nil,
                                 identifier: "changes-view-pr") { open(pull.url) }
                } else {
                    actionButton("Open pull request", icon: "arrow.triangle.pull", busy: publish.busy == .pullRequest,
                                 enabled: publish.busy == nil && !branch.isEmpty && !status.onDefaultBranch,
                                 identifier: "changes-open-pr") { publish.confirmingPullRequest = true }
                }
            }
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: PhrenTheme.Space.small) { actions }
            } else {
                HStack(spacing: PhrenTheme.Space.small) { actions }
            }
            if let landed = publish.landed {
                Text(landed)
                    .font(PhrenTypography.monoCaption)
                    .foregroundStyle(PhrenTheme.success)
                    .lineLimit(2)
                    .accessibilityIdentifier("changes-publish-landed")
            }
        }
        .padding(.horizontal, PhrenTheme.Space.medium)
        .padding(.vertical, PhrenTheme.Space.small)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("changes-publish")
    }

    private var pushTitle: String {
        if status.upstream == nil { return "Push new branch" }
        return status.ahead > 0 ? "Push \(status.ahead)" : "Pushed"
    }

    private func open(_ raw: String) {
        guard let url = URL(string: raw), url.scheme == "https" else { return }
        openURL(url)
    }

    private func actionButton(_ title: String, icon: String, prominent: Bool = false, busy: Bool = false, enabled: Bool,
                              identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy {
                    SessionActivityArc(color: prominent ? PhrenTheme.onAccent : PhrenTheme.accent)
                        .frame(width: 14, height: 14)
                        .accessibilityLabel("Working")
                } else {
                    Image(systemName: icon).font(PhrenTypography.icon(13, weight: .semibold))
                }
                Text(title).font(PhrenTypography.subheadline.weight(.medium)).lineLimit(1)
            }
            .foregroundStyle(prominent ? PhrenTheme.onAccent : PhrenTheme.accent)
            .padding(.horizontal, PhrenTheme.Space.medium)
            .frame(minHeight: 44)
            .background(prominent ? PhrenTheme.accentSolid : PhrenTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled || busy ? 1 : 0.45)
        .accessibilityIdentifier(identifier)
    }
}

/// The panel's confirmations and results, applied at the screen so the
/// dialog covers it rather than the panel's own frame.
struct ChangesPublishDialogs: ViewModifier {
    @Bindable var publish: ChangesPublishModel
    let changes: ChangesModel
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        let status = changes.status
        let branch = status?.branch ?? ""
        let onDefault = status?.onDefaultBranch == true
        content
            .phrenDialog(isPresented: $publish.confirmingPush,
                         title: onDefault ? "Push to \(branch), the default branch?" : "Push \(branch)?",
                         message: pushMessage(status),
                         actions: [
                            .init(id: "push", title: onDefault ? "Push to \(branch)" : "Push", role: onDefault ? .destructive : .normal) {
                                publish.push(changes, confirmDefault: onDefault)
                            },
                            .init(id: "cancel", title: "Cancel", role: .cancel) {},
                         ],
                         identifier: "changes-push-dialog")
            .phrenDialog(isPresented: $publish.confirmingPullRequest,
                         title: "Open a pull request for \(branch)?",
                         message: pullRequestMessage(status),
                         actions: [
                            .init(id: "open", title: "Open pull request") { publish.openPullRequest(changes, draft: false) },
                            .init(id: "draft", title: "Open as draft") { publish.openPullRequest(changes, draft: true) },
                            .init(id: "cancel", title: "Cancel", role: .cancel) {},
                         ],
                         identifier: "changes-pr-dialog")
            .phrenDialog(isPresented: Binding(get: { publish.notice != nil }, set: { if !$0 { publish.notice = nil } }),
                         title: publish.notice?.title ?? "",
                         message: publish.notice?.message ?? "",
                         actions: noticeActions,
                         identifier: publish.notice?.identifier ?? "changes-publish-dialog")
    }

    private var noticeActions: [PhrenDialog.Action] {
        guard let url = publish.notice?.url else {
            return [.init(id: "ok", title: "OK", role: .cancel) {}]
        }
        return [
            .init(id: "view", title: "View on GitHub") { openURL(url) },
            .init(id: "done", title: "Done", role: .cancel) {},
        ]
    }

    private func pushMessage(_ status: GitStatus?) -> String {
        guard let status else { return "" }
        let commits = status.ahead == 1 ? "1 commit" : "\(status.ahead) commits"
        if let upstream = status.upstream {
            return "Sends \(commits) to \(upstream). A push is never forced; if the remote has moved, it is refused."
        }
        return "Publishes \(status.branch ?? "this branch") to origin with \(commits) and tracks it there. A push is never forced."
    }

    private func pullRequestMessage(_ status: GitStatus?) -> String {
        guard let status else { return "" }
        var text = "The computer's GitHub CLI opens it from this branch's commits into the default branch, titled from them."
        if status.upstream == nil || status.ahead > 0 {
            text += " GitHub has not seen every commit here yet, so push first."
        }
        return text
    }
}
