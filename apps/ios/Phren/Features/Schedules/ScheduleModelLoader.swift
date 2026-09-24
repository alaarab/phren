import PhrenKit
import PhrenLive

@MainActor
enum ScheduleModelLoader {
    static func load(host: LiveHost, harness: Schedule.Harness) async throws -> [AgentModelChoice] {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.schedulesEnabled || AgentChatFixture.enabled {
            return AgentChatFixture.models(source: harness.rawValue)
        }
        #endif
        return try await PhrenConnection.models(
            host: host,
            privateKey: try DeviceSSHKey.load(host.id),
            source: harness.rawValue
        )
    }
}
