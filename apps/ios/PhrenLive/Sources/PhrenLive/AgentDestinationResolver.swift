import Foundation
import PhrenKit

public struct AgentDestination: Equatable, Sendable, Identifiable {
    public let host: LiveHost
    public let target: AgentChatTarget
    /// Nil is a remote lead's ordinary conversation. Every local or remote
    /// descendant carries the parent-scoped child id expected by its Hook.
    public let child: String?
    public let computer: AgentComputer?
    public let isRemote: Bool

    public var id: String {
        [computer?.id.uuidString.lowercased() ?? host.id.uuidString.lowercased(),
         target.conversationKey, child ?? "lead"].joined(separator: "/")
    }

    public func session(for agent: AgentChild) -> LiveAgentSession {
        LiveAgentSession(remoteHost: host, target: target, title: agent.name,
                         status: agent.state == .running ? "working" : "done", model: agent.model)
    }
}

public enum AgentDestinationResolution: Equatable, Sendable {
    case available(AgentDestination)
    case offline(AgentDestination)
    case unknown(AgentComputer)
    case starting(AgentComputer)

    public var destination: AgentDestination? {
        switch self {
        case .available(let value), .offline(let value): return value
        case .unknown, .starting: return nil
        }
    }
}

public enum AgentDestinationResolver {
    /// Child rows never carry addresses or credentials. A remote row can use
    /// only the enrolled host whose verified Hook id matches the descriptor.
    public static func resolve(agent: AgentChild, parentHost: LiveHost,
                               parentTarget: AgentChatTarget, hosts: [LiveHost],
                               offlineHostIDs: Set<UUID> = []) throws -> AgentDestinationResolution {
        guard let computer = agent.computer else {
            let destination = AgentDestination(host: parentHost, target: parentTarget,
                                               child: agent.id, computer: nil, isRemote: false)
            return offlineHostIDs.contains(parentHost.id) ? .offline(destination) : .available(destination)
        }
        let matched = hosts.first(where: { $0.hookComputerID == computer.id && $0.fingerprint != nil })
        guard let remote = agent.remote else {
            return matched == nil ? .unknown(computer) : .starting(computer)
        }
        guard var host = matched else { return .unknown(computer) }

        // The target's server is authoritative for this request. It scopes the
        // saved connection without accepting a host, pin, or key from the row.
        host.herdrSession = remote.target.server == "default" ? nil : remote.target.server
        let target = try AgentChatTarget(hostID: host.id,
                                         workspaceID: remote.target.workspace,
                                         tabID: remote.target.tab,
                                         paneID: remote.target.pane,
                                         source: remote.target.source,
                                         sessionID: remote.target.session,
                                         muxID: "herdr:\(remote.target.server)")
        let destination = AgentDestination(host: host, target: target, child: remote.child,
                                           computer: computer, isRemote: true)
        return offlineHostIDs.contains(host.id) ? .offline(destination) : .available(destination)
    }
}
