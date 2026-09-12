import ActivityKit
import AppIntents
import Foundation

/// The extension receives display text and an opaque local identifier only.
/// SSH destinations, exact conversation routes and credentials stay in the app.
struct ApprovalActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let provider: String
        let project: String
        let host: String
        let explanation: String
        let expiresAt: Date
    }
    let requestID: String
}

struct AnswerApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Answer agent permission"
    static var isDiscoverable: Bool = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Request") var requestID: String
    @Parameter(title: "Approve") var approve: Bool

    init() {}
    init(requestID: String, approve: Bool) { self.requestID = requestID; self.approve = approve }

    func perform() async throws -> some IntentResult {
        #if PHREN_APP
        await ApprovalActivityController.shared.answer(requestID: requestID, approve: approve)
        #else
        // LiveActivityIntent runs in the containing app. Never claim success if
        // a future system dispatches this extension-only implementation instead.
        try unavailable()
        #endif
        return .result()
    }
    private func unavailable() throws {
        throw NSError(domain: "PhrenApproval", code: 1, userInfo: [NSLocalizedDescriptionKey: "Open Phren to answer this request."])
    }
}
