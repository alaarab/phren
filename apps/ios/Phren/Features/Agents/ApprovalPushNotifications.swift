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
        ])
        Task {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            await MainActor.run { application.registerForRemoteNotifications() }
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
