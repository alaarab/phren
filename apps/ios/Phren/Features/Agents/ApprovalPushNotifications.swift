import Foundation
import PhrenKit
import PhrenLive
import UIKit
import UserNotifications

final class PhrenAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "PHREN_AGENT_APPROVAL", actions: [
                UNNotificationAction(identifier: "PHREN_APPROVE", title: "Approve", options: [.authenticationRequired]),
                UNNotificationAction(identifier: "PHREN_DENY", title: "Deny", options: [.authenticationRequired, .destructive]),
                UNNotificationAction(identifier: "PHREN_OPEN", title: "Review in Phren", options: [.foreground]),
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: "PHREN_AGENT_QUESTION", actions: [
                UNNotificationAction(identifier: "PHREN_OPEN", title: "Answer in Phren", options: [.foreground]),
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: "PHREN_SCHEDULE", actions: [
                UNNotificationAction(identifier: "PHREN_OPEN", title: "Open in Phren", options: [.foreground]),
            ], intentIdentifiers: []),
        ])
        NotificationBackgroundRefresh.register()
        // Refresh an existing APNs registration without asking at launch.
        Task {
            let status = await center.notificationSettings().authorizationStatus
            if status == .authorized || status == .provisional || status == .ephemeral {
                await MainActor.run { application.registerForRemoteNotifications() }
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        ApprovalPushNotifications.setToken(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.notification.request.content.userInfo["localKind"] != nil {
            Task { @MainActor in
                await LocalNotificationRouting.open(response.notification.request.content.userInfo)
                completionHandler()
            }
            return
        }
        if let notification = SchedulePushNotification(userInfo: response.notification.request.content.userInfo) {
            Task { @MainActor in SchedulePushNotifications.open(notification); completionHandler() }
            return
        }
        guard ["PHREN_APPROVE", "PHREN_DENY"].contains(response.actionIdentifier) else {
            Task { @MainActor in AppModel.current?.selectedTab = .agents; completionHandler() }
            return
        }
        Task {
            await ApprovalPushNotifications.answer(response.notification.request.content.userInfo,
                                                   approve: response.actionIdentifier == "PHREN_APPROVE")
            completionHandler()
        }
    }
}

struct SchedulePushNotification: Equatable {
    enum Kind: String { case scheduleStarted, scheduleFinished, scheduleFailed, scheduleBlocked }
    struct SessionRoute: Codable, Equatable {
        let server: String
        let workspace: String
        let tab: String
        let pane: String
        let source: String

        var valid: Bool {
            AgentChatTarget.validID(server) && !server.contains(":")
                && [workspace, tab, pane].allSatisfy(AgentChatTarget.validID)
                && AgentChatTarget.sources.contains(source)
        }
    }
    enum Destination: Equatable {
        case session(SessionRoute)
        case history(project: String, scheduleID: String)
    }

    let kind: Kind
    let scheduleID: String
    let project: String
    let name: String
    let computer: String
    let runID: String
    let status: String
    let reason: String?
    let route: String?

    init?(userInfo: [AnyHashable: Any]) {
        guard let value = userInfo["phren"] as? [String: Any],
              let kindText = value["kind"] as? String, let kind = Kind(rawValue: kindText),
              let scheduleID = value["scheduleId"] as? String,
              scheduleID.range(of: #"^[a-f0-9]{8}$"#, options: .regularExpression) != nil,
              let project = value["project"] as? String, !project.isEmpty,
              let name = value["name"] as? String, !name.isEmpty,
              let computer = value["computer"] as? String, !computer.isEmpty,
              let runID = value["runId"] as? String, !runID.isEmpty,
              let status = value["status"] as? String,
              ["running", "finished", "failed", "blocked"].contains(status) else { return nil }
        self.kind = kind; self.scheduleID = scheduleID; self.project = project; self.name = name
        self.computer = computer; self.runID = runID; self.status = status
        reason = value["reason"] as? String
        route = value["route"] as? String
    }

    var title: String {
        let state = kind == .scheduleStarted ? "started" : kind == .scheduleFinished ? "finished"
            : kind == .scheduleBlocked ? "blocked" : "failed"
        return "\(name) \(state)"
    }
    var body: String { "\(project) on \(computer)\(reason.map { ". \($0)" } ?? "")" }
    var destination: Destination {
        guard let route, let components = URLComponents(string: route), components.scheme == "phren", components.host == "session",
              let encoded = components.queryItems?.first(where: { $0.name == "route" })?.value,
              let data = Self.base64URLData(encoded), let session = try? JSONDecoder().decode(SessionRoute.self, from: data),
              session.valid else { return .history(project: project, scheduleID: scheduleID) }
        return .session(session)
    }

    private static func base64URLData(_ value: String) -> Data? {
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        return Data(base64Encoded: text)
    }
}

@MainActor
enum SchedulePushNotifications {
    static func open(_ notification: SchedulePushNotification) {
        switch notification.destination {
        case .session(let route):
            let hosts = (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
            if let host = hosts.first(where: { host in
                [host.name, host.address].contains(where: { canonical($0) == canonical(notification.computer) })
                    && host.muxID == "herdr:\(route.server)"
            }),
               let session = try? AgentLaunch.session(host: host, workspaceID: route.workspace, tabID: route.tab,
                                                       label: notification.name, agent: route.source,
                                                       agentStatus: notification.status == "running" ? "working"
                                                        : notification.status == "blocked" ? "waiting" : "idle", cwd: "/") {
                AgentLaunch.setPending(session)
                return
            }
        case .history: break
        }
        AppModel.current?.openScheduleHistory(project: notification.project, scheduleID: notification.scheduleID)
    }

    private static func canonical(_ value: String) -> String {
        var value = value.lowercased()
        if value.hasSuffix(".local") { value.removeLast(".local".count) }
        return value
    }
}

enum ApprovalPushNotifications {
    private static var token: String?
    private static var deviceID: UUID {
        let key = "approval.push.device-id.v1"
        if let saved = AppRuntime.defaults.string(forKey: key).flatMap(UUID.init(uuidString:)) { return saved }
        let value = UUID(); AppRuntime.defaults.set(value.uuidString.lowercased(), forKey: key); return value
    }

    static func setToken(_ value: String) {
        token = value
        Task { await registerSavedHosts() }
    }

    static func registerSavedHosts() async {
        guard let token else { return }
        let registrationDeviceID = deviceID
        let hosts = (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
        await withTaskGroup(of: Void.self) { group in
            for host in hosts {
                group.addTask {
                    guard let key = try? DeviceSSHKey.load(host.id) else { return }
                    #if DEBUG
                    let production = false
                    #else
                    let production = true
                    #endif
                    try? await PhrenConnection.registerApprovalPush(host: host, privateKey: key, deviceID: registrationDeviceID,
                                                                    token: token, production: production)
                }
            }
        }
    }

    static func answer(_ userInfo: [AnyHashable: Any], approve: Bool) async {
        guard let value = userInfo["phren"] as? [String: Any], let bindingText = value["binding"] as? String,
              let binding = UUID(uuidString: bindingText), let hostText = value["host"] as? String,
              let hostID = UUID(uuidString: hostText), let expiration = value["expiresAt"] as? String,
              let expiresAt = ISO8601DateFormatter().date(from: expiration), expiresAt > .now,
              let host = (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts.first(where: { $0.id == hostID }),
              let key = try? DeviceSSHKey.load(host.id) else { return }
        try? await PhrenConnection.answerApprovalPush(host: host, privateKey: key, binding: binding, approve: approve)
    }
}
