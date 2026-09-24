import AppIntents
import Foundation

/// "Hey Siri, talk to my conductor", the Action button and the Control Center
/// control: opens the running conductor's chat in talk mode, hands-free. It
/// listens until you pause, sends, reads the reply aloud and listens again,
/// with the screen locked too. With no conductor running it opens the
/// conductor launch instead. Runs in the app, like every control here.
struct TalkToConductorIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to my conductor"
    static var description = IntentDescription(
        "Opens your running conductor in talk mode: speak, hear its replies, and keep talking with the screen locked.",
        categoryName: "Agents", searchKeywords: ["conductor", "talk", "voice", "walkie-talkie", "siri"])
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        #if PHREN_APP
        return .result(dialog: "\(await WidgetBridge.talkToConductor())")
        #else
        return .result(dialog: "Open phren to talk to your conductor.")
        #endif
    }
}

/// The "Pause all agents" control. It never pauses on its own: it opens
/// phren on a confirmation that names the working agents first.
struct PauseAllAgentsIntent: AppIntent {
    static var title: LocalizedStringResource = "Pause All Agents"
    static var description = IntentDescription(
        "Opens phren to confirm interrupting every working agent on your computers.",
        categoryName: "Agents", searchKeywords: ["pause", "stop", "agents", "interrupt"])
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult {
        #if PHREN_APP
        WidgetBridge.requestPauseAll()
        #endif
        return .result()
    }
}
