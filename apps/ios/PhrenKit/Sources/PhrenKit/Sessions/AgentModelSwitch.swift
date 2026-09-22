import Foundation

public enum AgentModelSwitchError: LocalizedError, Equatable {
    case working

    public var errorDescription: String? {
        "This agent is working. The model switch can happen when the turn ends. Choose Switch after this turn."
    }
}

/// A success receipt is emitted only after the Hook verifies the harness.
public struct AgentModelSwitch: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let model: String
    public let name: String
    public let effort: String?

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 16_384 else { throw PhrenKitError.validation("The model switch reply is too large.") }
        let reply = try JSONDecoder().decode(Self.self, from: data)
        guard reply.ok, AgentModelChoice.command(for: reply.model) != nil,
              !reply.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, reply.name.count <= 100,
              !reply.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw PhrenKitError.validation("The computer did not confirm the model switch. Check the terminal before trying again.")
        }
        return reply
    }
}
