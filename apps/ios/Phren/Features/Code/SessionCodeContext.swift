import PhrenKit
import PhrenLive

/// Captures the navigation origin, including the exact pane conversation.
struct SessionCodeContext: Identifiable, Sendable {
    let storeID: String
    let project: String
    let host: LiveHost
    let target: AgentChatTarget
    var id: String { "\(storeID):\(project):\(host.id):\(target.sessionID)" }

    @MainActor func hasIndex() async -> Bool {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled { return true }
        #endif
        return (try? await PhrenConnection.codeStatus(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, storeID: storeID))?.available == true
    }
}
