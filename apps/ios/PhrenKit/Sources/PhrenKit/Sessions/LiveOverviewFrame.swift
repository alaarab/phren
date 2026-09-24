import Foundation

/// One frame of the Hook's `/v1/overview` stream: the overview when it
/// changed, or a heartbeat saying the overview the phone holds is current.
public enum LiveOverviewFrame: Equatable, Sendable {
    case overview(LiveWorkspaces)
    case heartbeat(LiveHookInfo?)

    private struct Envelope: Decodable {
        let type: String
        let phren: LiveHookInfo?
    }

    /// Heartbeats are small; an overview is read with the same checks as a
    /// polled `/v1/workspaces` answer, including the Hook envelope.
    public static func read(_ data: Data) throws -> Self {
        if data.count <= 16_384 {
            let envelope = try JSONDecoder().decode(Envelope.self, from: data)
            switch envelope.type {
            case "heartbeat": return .heartbeat(envelope.phren)
            case "overview": break
            default: throw PhrenKitError.validation("Phren Hook sent an unknown overview frame.")
            }
        }
        return .overview(try LiveWorkspaces.read(data, requiringHook: true))
    }
}
