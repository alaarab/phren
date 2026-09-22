import Foundation
import PhrenKit
import PhrenLive

@MainActor
enum LocalNotificationRouting {
    static func open(_ info: [AnyHashable: Any]) async {
        guard let kind = info["localKind"] as? String,
              let id = (info["hostID"] as? String).flatMap(UUID.init(uuidString:)),
              let host = LocalNotificationMonitor.shared.hosts.first(where: { $0.id == id }) else { return }
        if kind == "approval" {
            guard let workspace = info["workspaceID"] as? String, let tab = info["tabID"] as? String,
                  let mux = info["muxID"] as? String, mux == host.muxID,
                  let source = info["source"] as? String, AgentChatTarget.sources.contains(source),
                  [workspace, tab].allSatisfy(AgentChatTarget.validID),
                  let session = try? AgentLaunch.session(host: host, workspaceID: workspace, tabID: tab,
                    label: info["label"] as? String ?? "Permission request", agent: source,
                    agentStatus: nil, cwd: info["cwd"] as? String ?? "/") else { return }
            AgentLaunch.setPending(session)
        } else if kind == "schedule" {
            guard let project = info["project"] as? String, let scheduleID = info["scheduleID"] as? String,
                  let fire = info["fireDate"] as? TimeInterval else { return }
            // The run has no session until the computer launches it. Resolve
            // fresh history on tap, never route to yesterday's lastRun.
            if let key = try? DeviceSSHKey.load(host.id),
               let history = try? await PhrenConnection.scheduleHistory(host: host, privateKey: key,
                    project: project, id: scheduleID),
               let run = history.filter({ $0.startedAt.timeIntervalSince1970 >= fire - 1 && $0.status != .skipped })
                    .min(by: { $0.startedAt < $1.startedAt }),
               run.launch.mode == .herdr, let workspace = run.launch.workspaceID, let tab = run.launch.tabID,
               [workspace, tab].allSatisfy(AgentChatTarget.validID) {
                var destinationHost = host
                if let server = run.launch.server, AgentChatTarget.validID(server), !server.contains(":") {
                    destinationHost.herdrSession = server
                }
                let status = try? await PhrenConnection.schedules(host: host, privateKey: key)
                let schedule = status?.first { $0.project == project && $0.id == scheduleID }
                if let session = try? AgentLaunch.session(host: destinationHost, workspaceID: workspace, tabID: tab,
                    label: schedule?.name ?? "Scheduled run", agent: schedule?.harness.rawValue ?? "codex",
                    agentStatus: nil, cwd: "/") {
                    AgentLaunch.setPending(session)
                    return
                }
            }
            AppModel.current?.openScheduleHistory(project: project, scheduleID: scheduleID)
        }
    }
}
