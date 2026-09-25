import Foundation
import XCTest
@testable import PhrenKit

final class ConductorGrantTests: XCTestCase {
    func testDecodesFullGrant() throws {
        let json = """
        {"scope":"project:phone","actions":["dispatch","hand_off"],"computers":["Desk","Linuxbox"],"until":"2026-10-01T00:00:00.000Z"}
        """
        let grant = try JSONDecoder().decode(ConductorGrant.self, from: Data(json.utf8))
        XCTAssertEqual(grant.scope, "project:phone")
        XCTAssertEqual(grant.projectSlug, "phone")
        XCTAssertEqual(grant.scopeTitle, "phone")
        XCTAssertEqual(grant.actions, [.dispatch, .handOff])
        XCTAssertEqual(grant.computers, ["Desk", "Linuxbox"])
        XCTAssertEqual(grant.until, "2026-10-01T00:00:00.000Z")
        XCTAssertNotNil(grant.expiresAt)
    }

    func testDecodesMinimalGlobalGrant() throws {
        let json = #"{"scope":"global","actions":["dispatch"]}"#
        let grant = try JSONDecoder().decode(ConductorGrant.self, from: Data(json.utf8))
        XCTAssertEqual(grant.scope, "global")
        XCTAssertNil(grant.projectSlug)
        XCTAssertEqual(grant.scopeTitle, "Everywhere")
        XCTAssertEqual(grant.actions, [.dispatch])
        XCTAssertNil(grant.computers)
        XCTAssertNil(grant.until)
        XCTAssertNil(grant.expiresAt)
    }

    func testRejectsInvalidScope() {
        XCTAssertThrowsError(try JSONDecoder().decode(ConductorGrant.self,
            from: Data(#"{"scope":"project:","actions":["dispatch"]}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(ConductorGrant.self,
            from: Data(#"{"scope":"store:work","actions":["dispatch"]}"#.utf8)))
        XCTAssertThrowsError(try ConductorGrant(scope: "project:bad slug", actions: [.dispatch]))
    }

    func testRejectsInvalidActions() {
        XCTAssertThrowsError(try JSONDecoder().decode(ConductorGrant.self,
            from: Data(#"{"scope":"global","actions":[]}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(ConductorGrant.self,
            from: Data(#"{"scope":"global","actions":["dispatch","dispatch"]}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(ConductorGrant.self,
            from: Data(#"{"scope":"global","actions":["publish"]}"#.utf8)))
        XCTAssertThrowsError(try ConductorGrant(scope: "global", actions: []))
    }

    func testRejectsInvalidOptionalFields() {
        XCTAssertThrowsError(try JSONDecoder().decode(ConductorGrant.self,
            from: Data(#"{"scope":"global","actions":["dispatch"],"computers":[]}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(ConductorGrant.self,
            from: Data(#"{"scope":"global","actions":["dispatch"],"until":"tomorrow"}"#.utf8)))
        XCTAssertThrowsError(try ConductorGrant(scope: "global", actions: [.dispatch], computers: [""]))
    }

    func testDecodesApprovalWithConductorCall() throws {
        let json = """
        {"actionId":"act-1","title":"Allow dispatch?","message":"Send the brief",
         "conductor":{"action":"dispatch","project":"phone","computer":"Desk"}}
        """
        let approval = try JSONDecoder().decode(AgentApproval.self, from: Data(json.utf8))
        XCTAssertEqual(approval.conductor?.action, "dispatch")
        XCTAssertEqual(approval.conductor?.project, "phone")
        XCTAssertEqual(approval.conductor?.computer, "Desk")
    }

    func testApprovalWithoutConductorStillDecodes() throws {
        let json = #"{"actionId":"act-2","title":"Allow Bash?"}"#
        let approval = try JSONDecoder().decode(AgentApproval.self, from: Data(json.utf8))
        XCTAssertNil(approval.conductor)
    }

    func testApprovalDecisionRawValues() {
        XCTAssertEqual(ApprovalDecision.allowProject.rawValue, "allow-project")
        XCTAssertEqual(ApprovalDecision.allowEverywhere.rawValue, "allow-everywhere")
        XCTAssertTrue(ApprovalDecision.approve.allows)
        XCTAssertTrue(ApprovalDecision.allowProject.allows)
        XCTAssertFalse(ApprovalDecision.deny.allows)
    }
}
