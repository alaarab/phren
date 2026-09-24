import XCTest
import PhrenKit
@testable import Phren

/// Approve or Deny held on a lock-screen notification, with phren closed.
final class ApprovalPushAnswerTests: XCTestCase {
    private func info(binding: UUID, host: UUID, expires: Date) -> [AnyHashable: Any] {
        ["aps": ["category": "PHREN_AGENT_APPROVAL"],
         "phren": ["version": 1, "binding": binding.uuidString.lowercased(), "host": host.uuidString.lowercased(),
                   "expiresAt": expires.ISO8601Format()]]
    }

    func testAnswerGoesToTheNotificationsComputerWithItsBinding() async throws {
        let desk = try LiveHost(name: "Desk", address: "desk.example", username: "sam")
        let linuxbox = try LiveHost(name: "Linuxbox", address: "linuxbox.example", username: "sam")
        let binding = UUID()
        var sent: [(UUID, UUID)] = []
        let outcome = await ApprovalPushNotifications.answer(info(binding: binding, host: linuxbox.id, expires: .now.addingTimeInterval(600)),
                                                             approve: true, hosts: [desk, linuxbox]) { host, value in sent.append((host.id, value)) }
        XCTAssertEqual(outcome, .sent)
        XCTAssertEqual(sent.map(\.0), [linuxbox.id])
        XCTAssertEqual(sent.map(\.1), [binding])
    }

    func testEveryFailureIsReportedNotDropped() async throws {
        let desk = try LiveHost(name: "Desk", address: "desk.example", username: "sam")
        let never: (LiveHost, UUID) async throws -> Void = { _, _ in XCTFail("Must not send") }
        let expired = await ApprovalPushNotifications.answer(info(binding: UUID(), host: desk.id, expires: .now.addingTimeInterval(-1)),
                                                             approve: true, hosts: [desk], send: never)
        XCTAssertEqual(expired, .failed("This request expired."))
        let unknown = await ApprovalPushNotifications.answer(info(binding: UUID(), host: UUID(), expires: .now.addingTimeInterval(600)),
                                                             approve: true, hosts: [desk], send: never)
        XCTAssertEqual(unknown, .failed("Its computer isn't set up on this phone."))
        let malformed = await ApprovalPushNotifications.answer(["phren": ["binding": "nope"]], approve: false, hosts: [desk], send: never)
        XCTAssertEqual(malformed, .failed("This notification can't be answered from here."))
        let refused = await ApprovalPushNotifications.answer(info(binding: UUID(), host: desk.id, expires: .now.addingTimeInterval(600)),
                                                             approve: false, hosts: [desk]) { _, _ in
            throw PhrenKitError.validation("This approval is no longer pending.")
        }
        XCTAssertEqual(refused, .failed("This approval is no longer pending."))
    }
}
