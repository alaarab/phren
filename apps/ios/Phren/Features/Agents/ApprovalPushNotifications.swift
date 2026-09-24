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
        completionHandler(NotificationPreferences.presentation(NotificationPreferences.whileOpen()))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // Settings > Notifications can send every tap to Agents instead of the chat.
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier, NotificationPreferences.tapOpens() == .agents {
            Task { @MainActor in AppModel.current?.selectedTab = .agents; completionHandler() }
            return
        }
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
            // Tapping an approval opens its session's details, led by the request.
            let info = response.notification.request.content.userInfo
            Task { @MainActor in
                if !(await ApprovalPushNotifications.open(info)) { AppModel.current?.selectedTab = .agents }
                completionHandler()
            }
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
              ["running", "finished", "needs-you", "failed", "blocked"].contains(status) else { return nil }
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

    /// What a pushed approval's notification carries: an opaque binding, the
    /// computer it came from and when it stops being answerable.
    struct Push: Equatable {
        let binding: UUID
        let hostID: UUID
        let expiresAt: Date
        init?(userInfo: [AnyHashable: Any]) {
            guard let value = userInfo["phren"] as? [String: Any], let bindingText = value["binding"] as? String,
                  let binding = UUID(uuidString: bindingText), let hostText = value["host"] as? String,
                  let hostID = UUID(uuidString: hostText), let expiration = value["expiresAt"] as? String,
                  let expiresAt = ISO8601Dates.parse(expiration) else { return nil }
            self.binding = binding; self.hostID = hostID; self.expiresAt = expiresAt
        }
    }
    enum Outcome: Equatable { case sent, failed(String) }

    private static var savedHosts: [LiveHost] {
        (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
    }

    /// Approve or Deny from the notification (the system has already asked for
    /// Face ID or the passcode). A failure is never silent: it comes back as a
    /// notification saying the answer did not arrive.
    static func answer(_ userInfo: [AnyHashable: Any], approve: Bool) async {
        let outcome = await answer(userInfo, approve: approve, hosts: savedHosts) { host, binding in
            try await PhrenConnection.answerApprovalPush(host: host, privateKey: DeviceSSHKey.load(host.id), binding: binding, approve: approve)
        }
        guard case .failed(let reason) = outcome else { return }
        let content = UNMutableNotificationContent()
        content.title = approve ? "Approval didn't reach the agent" : "Deny didn't reach the agent"
        content.body = "\(reason) Open phren to answer it."
        content.sound = .default
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "approval-failed-\(UUID().uuidString)", content: content, trigger: nil))
    }

    static func answer(_ userInfo: [AnyHashable: Any], approve: Bool, hosts: [LiveHost], now: Date = .now,
                       send: (LiveHost, UUID) async throws -> Void) async -> Outcome {
        guard let push = Push(userInfo: userInfo) else { return .failed("This notification can't be answered from here.") }
        guard push.expiresAt > now else { return .failed("This request expired.") }
        guard let host = hosts.first(where: { $0.id == push.hostID }) else { return .failed("Its computer isn't set up on this phone.") }
        do { try await send(host, push.binding); return .sent }
        catch { return .failed(error.localizedDescription) }
    }

    /// Opens the session a tapped approval belongs to, on its details page.
    @MainActor
    static func open(_ userInfo: [AnyHashable: Any]) async -> Bool {
        guard let push = Push(userInfo: userInfo), let host = savedHosts.first(where: { $0.id == push.hostID }),
              let key = try? DeviceSSHKey.load(host.id),
              let target = try? await PhrenConnection.approvalPushTarget(host: host, privateKey: key, binding: push.binding) else { return false }
        var destination = host
        if target.server != (host.herdrSession ?? "default") { destination.herdrSession = target.server }
        guard let session = try? AgentLaunch.session(host: destination, workspaceID: target.workspaceID, tabID: target.tabID,
                                                     label: "Permission request", agent: target.source, agentStatus: "blocked", cwd: "/") else { return false }
        AgentLaunch.setPending(session, destination: .details)
        return true
    }
}
