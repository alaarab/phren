import AppIntents
import Foundation
import PhrenKit

struct PinSessionActivityIntent: AppIntent {
    static var title: LocalizedStringResource = "Pin Working Session"
    static var description = IntentDescription("Shows a working agent session on the Lock Screen and Dynamic Island.", categoryName: "Agents")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session", requestValueDialog: "Which session?")
    var session: AgentSessionEntity

    static var parameterSummary: some ParameterSummary { Summary("Pin \(\.$session)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let live = await AgentSessions.current()
        let projects = await SpotlightProjects.current()
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        let reports = SessionStatusService.reports(for: live, projects: projects, preferences: preferences)
        guard let report = SessionStatusService.resolve(session, among: reports), report.state == .working else {
            return .result(dialog: "That session is not working right now.")
        }
        guard await SessionWorkingActivityController.shared.pin(report.entity) else {
            return .result(dialog: "Live Activities are not available right now.")
        }
        return .result(dialog: "Showing \(report.harnessName) on \(report.projectName) on your Lock Screen.")
    }
}
