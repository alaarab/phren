import Foundation
import XCTest
@testable import PhrenKit

final class AgentChildRemoteTests: XCTestCase {
    func testRemoteFixtureKeepsComputerAndParentScopedChildIdentities() throws {
        let url = try Fixtures.url("agent-children-remote.json")
        let tree = try AgentChildTree.read(Data(contentsOf: url))
        let lead = try XCTUnwrap(tree.agents.first)
        let nested = try XCTUnwrap(lead.children.first)

        XCTAssertEqual(lead.computer?.name, "Linuxbox")
        XCTAssertEqual(lead.computer?.id, UUID(uuidString: "c1000000-0000-0000-0000-000000000002"))
        XCTAssertNil(lead.remote?.child)
        XCTAssertEqual(lead.remote?.target.server, "work")
        XCTAssertEqual(nested.remote?.child, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        XCTAssertNotEqual(lead.navigationID, nested.navigationID)
        XCTAssertNil(tree.agents.last?.computer, "Older local rows keep decoding without descriptors")
        XCTAssertNil(tree.peerError, "A Hook that read its peers sends no peerError")
    }

    func testTreeCarriesTheHooksYamlProblemThatHidRemoteChildren() throws {
        let tree = try AgentChildTree.read(Data(#"{"agents":[],"peerError":"hooks.yaml is invalid at version: Invalid literal value, expected 1"}"#.utf8))
        XCTAssertEqual(tree.peerError, "hooks.yaml is invalid at version: Invalid literal value, expected 1")
    }

    func testRemoteTargetRequiresComputerAndValidTarget() throws {
        let target = #"{"server":"default","workspace":"w","tab":"w:t","pane":"w:p","source":"codex","session":"00000000-0000-0000-0000-000000000042"}"#
        let computer = #"{"id":"c1000000-0000-0000-0000-000000000002","name":"Linuxbox"}"#
        let base = #""id":"remote","provider":"codex","path":"Checks","callId":"dispatch:checks","state":"running","children":[]"#
        for fields in [#""remote":{"target":\#(target)},"#,
                       #""computer":\#(computer),"remote":{"target":{"server":"bad:name","workspace":"w","tab":"w:t","pane":"w:p","source":"codex","session":"00000000-0000-0000-0000-000000000042"}},"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(AgentChild.self,
                from: Data("{\(fields)\(base)}".utf8)))
        }
        let startingFields = #""computer":\#(computer),"#
        let starting = try JSONDecoder().decode(AgentChild.self,
            from: Data("{\(startingFields)\(base)}".utf8))
        XCTAssertNotNil(starting.computer); XCTAssertNil(starting.remote)
    }

    func testSamePublicIdsOnDifferentComputersHaveDifferentNavigationIdentity() throws {
        func child(_ computer: String) throws -> AgentChild {
            let data = #"{"id":"same","provider":"codex","path":"Checks","callId":"dispatch:checks","state":"running","computer":{"id":"\#(computer)","name":"Desk"},"remote":{"target":{"server":"default","workspace":"w","tab":"w:t","pane":"w:p","source":"codex","session":"00000000-0000-0000-0000-000000000042"},"child":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"children":[]}"#
            return try JSONDecoder().decode(AgentChild.self, from: Data(data.utf8))
        }
        let desk = try child("c1000000-0000-0000-0000-000000000001")
        let linux = try child("c1000000-0000-0000-0000-000000000002")
        XCTAssertNotEqual(desk.navigationID, linux.navigationID)
    }

    func testNavigationIdentitySurvivesStatusAndLabelRefresh() throws {
        let first = try child(state: "running", path: "Parser checks")
        let refreshed = try child(state: "completed", path: "Parser checks returned")
        XCTAssertEqual(first.navigationID, refreshed.navigationID)
    }

    func testHookIdentityPersistsSeparatelyFromPhoneHostID() throws {
        let phoneID = UUID(uuidString: "a1000000-0000-0000-0000-000000000001")!
        let hookID = UUID(uuidString: "c1000000-0000-0000-0000-000000000001")!
        let host = try LiveHost(id: phoneID, name: "Desk", address: "desk.example", username: "sam",
                                fingerprint: "SHA256:" + String(repeating: "A", count: 43))
        let saved = try LiveSessionPreferences.saving(host, in: Data())
        let associated = try LiveSessionPreferences.associating(hostID: phoneID, hookComputerID: hookID, in: saved)
        let restored = try XCTUnwrap(LiveSessionPreferences.read(associated).hosts.first)

        XCTAssertEqual(restored.id, phoneID)
        XCTAssertEqual(restored.hookComputerID, hookID)
        XCTAssertNotEqual(restored.id, restored.hookComputerID)
    }

    func testWorkspaceResponseDecodesVerifiedHookIdentityAndOldResponse() throws {
        let current = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[],"phren":{"product":"phren-hook","protocol":1,"computer":{"id":"c1000000-0000-0000-0000-000000000001","name":"Desk"}}}"#.utf8))
        let old = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[]}"#.utf8))
        XCTAssertEqual(current.computer?.id, UUID(uuidString: "c1000000-0000-0000-0000-000000000001"))
        XCTAssertNil(old.computer)
    }

    private func child(state: String, path: String) throws -> AgentChild {
        let json = #"{"id":"remote","provider":"codex","path":"\#(path)","callId":"dispatch:checks","state":"\#(state)","computer":{"id":"c1000000-0000-0000-0000-000000000002","name":"Linuxbox"},"remote":{"target":{"server":"default","workspace":"w","tab":"w:t","pane":"w:p","source":"codex","session":"00000000-0000-0000-0000-000000000042"},"child":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"children":[]}"#
        return try JSONDecoder().decode(AgentChild.self, from: Data(json.utf8))
    }
}
