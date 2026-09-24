import Foundation
import PhrenKit
import PhrenLive
import SwiftUI

/// The conductor card's second line: its latest dispatch or return, from the
/// Hook's dispatch receipts on the conductor's computer. Refreshed on the
/// phone's one timer while Live sessions shows a conductor.
@Observable @MainActor
final class ConductorActivityStore {
    static let shared = ConductorActivityStore()
    private(set) var activity: [UUID: ConductorActivity] = [:]

    func follow(_ host: LiveHost) async {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting, ProcessInfo.processInfo.arguments.contains("--conductor-store-root-fixture") {
            activity[host.id] = ConductorActivity(line: "Returned: Phone layout finished", at: .now)
            return
        }
        #endif
        await LiveRefresh.shared.every(.seconds(20), key: "conductor-activity:\(host.id)") { [weak self] in
            guard let value = try? await PhrenConnection.conductorActivity(host: host, privateKey: DeviceSSHKey.load(host.id)) else { return }
            if self?.activity[host.id] != value { self?.activity[host.id] = value }
        }
    }
}
