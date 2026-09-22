#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit

enum ProjectAgentChooserFixture {
    static func host(_ index: Int) throws -> LiveHost {
        let name = index == 0 ? "Desk" : index == 1 ? "Linuxbox" : String(format: "Desk%02d", index)
        return try LiveHost(id: UUID(uuidString: String(format: "D1000000-0000-0000-0000-%012d", index))!,
                            name: name, address: "computer.invalid", username: "sam",
                            fingerprint: "SHA256:" + String(repeating: "A", count: 43),
                            color: LiveHost.colorPalette[index % LiveHost.colorPalette.count])
    }

    @MainActor static func populate(store: LocalStore) async throws {
        var preferences = Data()
        var recent = Data()
        for index in 0..<50 {
            let computer = try host(index)
            preferences = try LiveSessionPreferences.saving(computer, in: preferences)
            preferences = try LiveSessionPreferences.assigning(hostID: computer.id, directory: "/home/sam/phone",
                                                               storeID: "sample/brain", project: "phone", in: preferences)
            if index < 3 {
                let age: TimeInterval = index == 1 ? 10 : index == 2 ? 20 : 30
                recent = ProjectAgentRecents.recording(storeID: "sample/brain", project: "phone", hostID: computer.id,
                                                       at: .now.addingTimeInterval(-age), in: recent)
            }
        }
        AppRuntime.defaults.set(preferences, forKey: "sessions.live.preferences.v1")
        AppRuntime.defaults.set(recent, forKey: ProjectAgentRecents.key)
        try await store.write("phone/FINDINGS.md", content: "# Findings\n\n- [pattern] Keep computer choices searchable\n", blobSha: nil)
    }

    static func snapshot(host: LiveHost) throws -> LiveWorkspaces {
        if host.name == "Desk02" { throw PhrenKitError.validation("SSH connection refused.") }
        let tabs: String
        if host.name == "Desk" {
            tabs = #"{"id":"w1:t1","label":"1","agent":"codex","agentStatus":"working","cwd":"/home/sam/phone"},{"id":"w1:t2","label":"2","agent":"claude","agentStatus":"idle","cwd":"/home/sam/phone"}"#
        } else if host.name == "Linuxbox" {
            tabs = #"{"id":"w1:t1","label":"1","agent":"codex","agentStatus":"idle","cwd":"/home/sam/phone"}"#
        } else { tabs = "" }
        return try LiveWorkspaces.read(Data("{\"kind\":\"herdr\",\"groups\":[{\"id\":\"w1\",\"label\":\"phone\",\"children\":[\(tabs)]}]}".utf8))
    }
}
#endif
