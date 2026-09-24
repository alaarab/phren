import Foundation

public struct AgentFanoutCapability: Codable, Equatable, Sendable {
    public let resumable: Bool
}

public struct AgentFanoutMessage: Codable, Equatable, Sendable, Identifiable {
    public enum Status: String, Codable, Sendable { case queued, running, completed, failed }
    public let id: UUID
    public let text: String
    public let status: Status
    public let createdAt: String

    public static func receipt(_ data: Data) throws -> Self {
        struct Receipt: Decodable { let ok: Bool; let message: AgentFanoutMessage }
        let value = try JSONDecoder().decode(Receipt.self, from: data)
        guard value.ok else { throw PhrenKitError.validation("The worker did not accept this message.") }
        return value.message
    }

    public static func list(_ data: Data) throws -> [Self] {
        struct Messages: Decodable { let messages: [AgentFanoutMessage] }
        return try JSONDecoder().decode(Messages.self, from: data).messages
    }
}

public extension AgentChild {
    enum MessageDestination: Equatable, Sendable { case session, worker, parent, unavailableWorker }

    var messageDestination: MessageDestination {
        if let remote, remote.child == nil { return .session }
        if fanout?.resumable == true { return .worker }
        if fanout != nil || callId.hasPrefix("fanout:") { return .unavailableWorker }
        return .parent
    }

    var messageNote: String {
        switch messageDestination {
        case .session: return "Messages go directly to this agent session."
        case .worker: return "Continues this worker's own session. Messages wait in its queue while it runs."
        case .parent: return "This sub-agent cannot receive input. Your message goes to its parent, labeled with this sub-agent's name."
        case .unavailableWorker: return "This worker has no resumable session available."
        }
    }

    func parentMessage(_ text: String) -> String { "About the \(name) sub-agent: \(text)" }

    /// A fan-out worker this computer's Hook started for the chat, finished
    /// without a failure: what the tree folds into "N finished". A failed or
    /// refused worker stays in view; Clear finished archives it on the Hook too.
    var isFinishedLocalWorker: Bool {
        computer == nil && remote == nil && (fanout != nil || callId.hasPrefix("fanout:")) && displayState == .completed
    }
}
