import Foundation
import PhrenKit
import PhrenLive

/// Resolve the overview's tab-level badge to authenticated, exact conversations.
/// A permission must reach ActivityKit even when its chat has never been opened.
@MainActor
final class OverviewApprovalMonitor {
    struct Request {
        let target: AgentChatTarget
        let approval: AgentApproval?
        /// A permission the agent draws in its terminal after the hold ended.
        var terminalPrompt: AgentTerminalPrompt? = nil
    }
    private let read: (LiveAgentSession) async throws -> [Request]
    private let sync: (AgentApproval?, LiveAgentSession, AgentChatTarget) async -> Void
    private var observed: [AgentChatTarget: LiveAgentSession] = [:]

    init(read: @escaping (LiveAgentSession) async throws -> [Request] = OverviewApprovalMonitor.pending,
         sync: @escaping (AgentApproval?, LiveAgentSession, AgentChatTarget) async -> Void = {
             await ApprovalActivityController.shared.sync($0, session: $1, target: $2)
         }) {
        self.read = read; self.sync = sync
    }

    func refresh(_ sessions: [LiveAgentSession]) async {
        let pending = sessions.filter { $0.tab.approvalPending == true }
        let pendingIDs = Set(pending.map(\.id))
        for (target, session) in observed where !pendingIDs.contains(session.id) {
            guard !Task.isCancelled else { return }
            observed.removeValue(forKey: target)
            await sync(nil, session, target)
        }
        await withTaskGroup(of: Void.self) { group in
            for session in pending {
                group.addTask { await self.refresh(session) }
            }
        }
    }

    private func refresh(_ session: LiveAgentSession) async {
        guard let requests = try? await read(session), !Task.isCancelled else { return }
        for request in requests {
            guard !Task.isCancelled else { return }
            // The pane lookup is not permission to switch host, tab or mux.
            let target = request.target
            guard target.hostID == session.host.id, target.muxID == session.host.muxID,
                  target.workspaceID == session.workspaceID, target.tabID == session.tab.id,
                  !target.isStarting else { continue }
            observed[target] = session
            await sync(request.approval, session, target)
        }
    }

    static func pending(_ session: LiveAgentSession) async throws -> [Request] {
        let panes = try await AgentChatModel.fetchPanes(session)
        // A tab can contain several agents. Never substitute its first pane
        // for the pane whose authenticated status actually has a request.
        return await withTaskGroup(of: Request?.self) { group in
            for pane in panes.panes {
                guard let target = try? pane.target(hostID: session.host.id, workspaceID: session.workspaceID,
                                                   tabID: session.tab.id, muxID: session.host.muxID), !target.isStarting else { continue }
                group.addTask {
                    try? await withThrowingTaskGroup(of: Request?.self) { statusGroup in
                        statusGroup.addTask {
                            for try await status in PhrenConnection.interactionUpdates(host: session.host,
                                privateKey: try DeviceSSHKey.load(session.host.id), target: target) {
                                return Request(target: target, approval: status.approval, terminalPrompt: status.terminalPrompt)
                            }
                            return nil
                        }
                        statusGroup.addTask { try await Task.sleep(for: .seconds(2)); return nil }
                        defer { statusGroup.cancelAll() }
                        return try await statusGroup.next() ?? nil
                    }
                }
            }
            var requests: [Request] = []
            for await request in group { if let request { requests.append(request) } }
            return requests
        }
    }
}
