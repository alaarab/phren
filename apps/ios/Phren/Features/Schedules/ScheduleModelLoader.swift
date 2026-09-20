import PhrenKit
import PhrenLive

@MainActor
enum ScheduleModelLoader {
    static func load(host: LiveHost, harness: Schedule.Harness) async throws -> [AgentModelChoice] {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            return AgentChatFixture.models(source: source(for: harness))
        }
        #endif
        return try await PhrenConnection.models(
            host: host,
            privateKey: try DeviceSSHKey.load(host.id),
            source: source(for: harness)
        )
    }

    nonisolated static func source(for harness: Schedule.Harness) -> String {
        switch harness {
        case .claude: "claude"
        case .codex: "codex"
        case .opencode: "opencode"
        }
    }
}
