import Foundation
import PhrenKit
import PhrenLive

/// "Pause all agents": interrupts the turn of every agent that is working on
/// any computer, the same Escape the chat's stop button sends. Agents stay
/// open and keep their conversations; each one waits for its next message.
/// It only ever runs from the confirmation sheet, never from a control alone.
@MainActor
enum AgentFleetPause {
    struct Outcome: Equatable {
        /// Agent panes whose turn was interrupted.
        var paused = 0
        /// Sessions or panes that could not be reached or refused the stop.
        var failed: [String] = []

        var summary: String {
            let agents = paused == 1 ? "1 agent" : "\(paused) agents"
            guard !failed.isEmpty else { return paused == 0 ? "No agent was working." : "Paused \(agents)." }
            let missed = failed.count == 1 ? "1 couldn't be reached" : "\(failed.count) couldn't be reached"
            return "Paused \(agents); \(missed): \(failed.joined(separator: ", "))."
        }
    }

    /// The working agent panes of one session, as stop targets.
    typealias Panes = @MainActor (LiveAgentSession) async throws -> [AgentChatTarget]
    typealias Stop = @MainActor (LiveAgentSession, AgentChatTarget) async throws -> Void

    /// The sessions the sheet offers to pause: those whose tab is working.
    static func candidates(_ sessions: [LiveAgentSession]) -> [LiveAgentSession] {
        sessions.filter { $0.tab.agent != nil && $0.tab.activity == .working }
    }

    static func pause(_ sessions: [LiveAgentSession], panes: Panes = livePanes, stop: Stop = liveStop) async -> Outcome {
        var outcome = Outcome()
        for session in candidates(sessions) {
            let name = session.tab.displayTitle
            do {
                let targets = try await panes(session)
                guard !targets.isEmpty else { continue }
                for target in targets {
                    do { try await stop(session, target); outcome.paused += 1 }
                    catch { outcome.failed.append(name) }
                }
            } catch {
                outcome.failed.append(name)
            }
        }
        return outcome
    }

    /// Only panes whose agent is working now: an idle helper in the same tab
    /// is left alone.
    static func workingTargets(_ panes: AgentChatPanes, session: LiveAgentSession) -> [AgentChatTarget] {
        panes.panes.filter { $0.agentStatus == "working" }.compactMap {
            try? $0.target(hostID: session.host.id, workspaceID: session.workspaceID,
                           tabID: session.tab.id, muxID: session.host.muxID)
        }
    }

    static let livePanes: Panes = { session in
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { return workingTargets(try AgentChatFixture.panes(session), session: session) }
        #endif
        let panes = try await PhrenConnection.chatPanes(host: session.host, privateKey: DeviceSSHKey.load(session.host.id),
                                                        workspaceID: session.workspaceID, tabID: session.tab.id)
        return workingTargets(panes, session: session)
    }

    static let liveStop: Stop = { session, target in
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { AgentChatFixture.stopped = true; AgentChatFixture.pausedTargets.append(target.id); return }
        #endif
        try await PhrenConnection.stopChatTurn(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target)
    }
}
