import PhrenKit
import PhrenLive
import SwiftUI

/// What a session is asking permission for, answered from its details page.
/// A request the Hook still holds is approved through `/v1/approvals/answer`;
/// one the agent draws in its own terminal (the hold ended, or it never had
/// a hook) is answered with that dialog's yes or no row, as the Hook's push does.
struct SessionPermission: Equatable {
    let target: AgentChatTarget
    let approval: AgentApproval?
    let prompt: AgentTerminalPrompt?

    var question: Bool { approval?.isQuestion == true || prompt?.questionPrompt != nil }
    /// Answerable here: a held approval, or a terminal dialog with rows to pick.
    var answerable: Bool { !question && (approval != nil || prompt?.choice != nil) }

    /// The tool, readable: `mcp__phren__manage_task` reads "Manage task".
    var toolTitle: String {
        let raw = approval?.toolName ?? prompt?.toolName ?? ""
        guard !raw.isEmpty, !["Question", "Permissions", "action"].contains(raw) else { return question ? "Question" : "Permission request" }
        let name = raw.hasPrefix("mcp__") ? String(raw.components(separatedBy: "__").last ?? raw) : raw
        let words = name.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// The asking sentence, then what it is about: the command, or the
    /// request's own fields one per line.
    var request: (title: String?, detail: String?) {
        let title = (approval?.choice?.title ?? approval?.title ?? prompt?.choice?.title)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let command = approval?.command ?? prompt?.choice?.body ?? prompt?.command
        let detail = command ?? Self.fields(approval?.message ?? prompt?.message) ?? approval?.explanation
        let trimmed = detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (title?.isEmpty == false ? title : nil, trimmed?.isEmpty == false && trimmed != title ? trimmed : nil)
    }

    private static func fields(_ message: String?) -> String? {
        guard let message, let input = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any] else { return message }
        let lines = input.keys.sorted().compactMap { key -> String? in
            switch input[key] {
            case let text as String where !text.isEmpty: return "\(key): \(text)"
            case let number as NSNumber: return "\(key): \(number)"
            case let list as [String] where !list.isEmpty: return "\(key): \(list.joined(separator: ", "))"
            default: return nil
            }
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// The first pane in the tab with something to answer, read from its
    /// authenticated status within two seconds.
    static func load(_ session: LiveAgentSession) async -> SessionPermission? {
        #if DEBUG && targetEnvironment(simulator)
        if fixture, let target = try? AgentChatTarget(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id,
                                                       paneID: "\(session.workspaceID):p1", source: session.tab.agent ?? "claude",
                                                       sessionID: "c78d4154-076d-49fc-acbb-2084bb32f0a9", muxID: session.host.muxID) {
            return SessionPermission(target: target, approval: nil, prompt: AgentTerminalPrompt(
                toolName: "mcp__phren__manage_task", message: #"{"action":"complete","project":"global","item":"Ship the release"}"#,
                choice: AgentPromptChoice(title: "Do you want to proceed?", options: [
                    .init(label: "Yes", key: "1"), .init(label: "No", key: "2"), .init(label: "Cancel", key: "Escape"),
                ])))
        }
        #endif
        guard let requests = try? await OverviewApprovalMonitor.pending(session) else { return nil }
        return requests.lazy.map { SessionPermission(target: $0.target, approval: $0.approval, prompt: $0.terminalPrompt) }
            .first { $0.approval != nil || $0.prompt != nil }
    }

    /// Approve or deny with the request's own channel.
    func answer(on host: LiveHost, approve: Bool) async throws {
        #if DEBUG && targetEnvironment(simulator)
        if Self.fixture { return }
        #endif
        let key = try DeviceSSHKey.load(host.id)
        if let approval {
            await ApprovalActivityController.shared.answered(target: target, actionID: approval.id)
            try await PhrenConnection.answerApproval(host: host, privateKey: key, target: target, actionID: approval.actionId, approve: approve)
        } else if let choice = prompt?.choice {
            guard let typed = approve ? choice.approveKey : choice.rejectKey else { throw PhrenKitError.validation("Open the terminal to answer.") }
            try await PhrenConnection.answerWithKeys(host: host, privateKey: key, target: target, keys: [typed])
        }
    }

    #if DEBUG && targetEnvironment(simulator)
    static var fixture: Bool { ProcessInfo.processInfo.arguments.contains("--details-approval-fixture") }
    #endif
}

/// The details page's hero while a permission waits: the agent, the tool it
/// wants, where, and a PERMISSION chip.
struct SessionPermissionHero: View {
    let session: LiveAgentSession
    let permission: SessionPermission
    let project: String
    let projectColor: Color

    var body: some View {
        VStack(spacing: 12) {
            AgentProviderGlyph(source: session.tab.agent, size: 44)
                .frame(width: 88, height: 88)
                .background(PhrenTheme.warning.opacity(0.14), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            Text(permission.toolTitle).font(.title2.weight(.bold)).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Text(project).font(.system(.subheadline, design: .monospaced)).foregroundStyle(projectColor)
                Text("·").foregroundStyle(PhrenTheme.textDim)
                Text(session.host.name).font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                if let date = session.tab.lastChangedAt {
                    Text("·").foregroundStyle(PhrenTheme.textDim)
                    SessionRelativeTimeLabel(changedAt: date)
                }
            }.lineLimit(1).minimumScaleFactor(0.8)
            Text(permission.question ? "QUESTION" : "PERMISSION")
                .font(.caption.weight(.bold)).tracking(1.2).foregroundStyle(PhrenTheme.warning)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(PhrenTheme.warning.opacity(0.16), in: Capsule())
        }
        .frame(maxWidth: .infinity).padding(.vertical, 28).padding(.horizontal, 20)
        .background(PhrenTheme.warning.opacity(0.06), in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session-approval")
    }
}

/// The request's text, and Deny / Approve under the ways into the session.
struct SessionPermissionRequest: View {
    let permission: SessionPermission
    var body: some View {
        let request = permission.request
        if request.title != nil || request.detail != nil {
            VStack(alignment: .leading, spacing: 8) {
                if let title = request.title {
                    Text(title).font(.body).foregroundStyle(PhrenTheme.text).fixedSize(horizontal: false, vertical: true)
                }
                if let detail = request.detail {
                    Text(detail).font(.system(.footnote, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted)
                        .lineLimit(8).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
            .accessibilityIdentifier("session-approval-request")
        }
    }
}

struct SessionPermissionActions: View {
    let session: LiveAgentSession
    let permission: SessionPermission
    @State private var answering = false
    @State private var result: String?

    var body: some View {
        Group {
            if let result {
                Text(result).font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity).accessibilityIdentifier("session-approval-result")
            } else if permission.answerable {
                HStack(spacing: 10) {
                    button("Deny", approve: false)
                    button("Approve", approve: true)
                }
            } else {
                Text(permission.question ? "Answer this question in the chat." : "Open the terminal to answer.")
                    .font(.footnote).foregroundStyle(PhrenTheme.textMuted).frame(maxWidth: .infinity)
            }
        }
        .onChange(of: permission) { _, _ in result = nil }
    }

    private func button(_ title: String, approve: Bool) -> some View {
        Button { Task { await answer(approve) } } label: {
            Text(title).font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 50)
                .background(approve ? PhrenTheme.accent : PhrenTheme.surface, in: Capsule())
                .overlay(Capsule().stroke(approve ? Color.clear : PhrenTheme.border, lineWidth: 1))
                .foregroundStyle(approve ? Color.black : PhrenTheme.text)
        }
        .buttonStyle(.plain).disabled(answering)
        .accessibilityIdentifier(approve ? "session-approval-approve" : "session-approval-deny")
    }

    private func answer(_ approve: Bool) async {
        guard !answering else { return }
        answering = true
        defer { answering = false }
        do {
            try await permission.answer(on: session.host, approve: approve)
            result = approve ? "Approved. \(permission.target.providerName) continues." : "Denied."
        } catch {
            result = "\(error.localizedDescription) Check the terminal before answering again."
        }
    }
}
