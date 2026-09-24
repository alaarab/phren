import XCTest
@testable import PhrenKit

/// The conductor's live_sessions, hand_off and dispatch calls, from the shapes
/// the Hook really returns (phren_admin with an action, as the conductor calls them).
final class PhrenConductorToolTests: XCTestCase {
    private func envelope(_ data: [String: Any], ok: Bool = true, message: String? = nil) -> String {
        var value: [String: Any] = ["ok": ok, "data": data]
        if let message { value["message"] = message }
        return String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    func testLiveSessionsGroupByComputerWithStatusAndTheComputersItCouldNotSee() throws {
        let target: [String: Any] = ["server": "default", "workspace": "w13", "tab": "w13:t2", "pane": "w13:p2", "source": "claude", "session": "s1"]
        let result = envelope([
            "sessions": [
                ["computer": "Mini", "project": "phren", "label": "phren", "title": "Claude sesh", "status": "idle", "idleFor": 1768, "target": target],
                ["computer": "Mini", "project": "ObjectStudio", "label": "objectstudio", "title": "MCP livemcp", "status": "working"],
                ["computer": "Omarchy", "project": "hub", "label": "hub", "title": "Get on main", "status": "blocked"],
                ["computer": "Mini", "label": "Conductor", "title": "Job and purpose", "status": "done", "role": "conductor"],
            ],
            "unreachable": [["computer": "Linuxbox", "error": "timed out"]],
            "notLinked": [["name": "MacBookPro", "aliases": ["Alas-MacBook-Pro.local"]]],
        ], message: "4 live sessions across 2 computers.")
        let card = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__phren_admin", input: #"{"action":"live_sessions"}"#, result: result))
        XCTAssertEqual(card.verb, "Live sessions")
        XCTAssertEqual(card.resultSummary, "4 sessions on 2 computers")
        guard case .sessions(let groups, let missing) = card.conductor else { return XCTFail("no sessions card") }
        XCTAssertEqual(groups.map(\.computer), ["Mini", "Omarchy"])
        XCTAssertEqual(groups[0].rows.map(\.status), ["idle", "working", "done"])
        XCTAssertEqual(groups[0].rows[0].idleFor, 1768)
        XCTAssertTrue(groups[0].rows[2].conductor)
        XCTAssertEqual(groups[1].rows[0].status, "needs-you")
        XCTAssertEqual(missing, ["Linuxbox (unreachable)", "MacBookPro"])
        // The direct tool name draws the same card.
        XCTAssertNotNil(PhrenToolPresentation(name: "mcp__phren__live_sessions", input: "{}", result: result)?.conductor)
    }

    func testHandOffNamesTheTargetAndKeepsThePromptAsTheBody() throws {
        let target = #"{\"server\":\"default\",\"workspace\":\"w1P\",\"tab\":\"w1P:t2\",\"pane\":\"w1P:p2\",\"source\":\"claude\",\"session\":\"804efd90\"}"#
        let input = #"{"action":"hand_off","target":"\#(target)","text":"From the conductor: you're paired with ObjectStudio.\nSecond line."}"#
        let delivered = envelope(["ok": true, "delivered": true, "label": "objectstudio",
                                  "target": ["pane": "w1P:p2", "session": "804efd90"]], message: "Prompt delivered to the existing session.")
        let card = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__phren_admin", input: input, result: delivered))
        XCTAssertEqual(card.verb, "Hand off")
        XCTAssertEqual(card.conductor, .handOff(target: "objectstudio (w1P:p2)"))
        XCTAssertEqual(card.body, "From the conductor: you're paired with ObjectStudio.\nSecond line.")
        XCTAssertEqual(card.resultSummary, "Delivered")
        XCTAssertEqual(card.status, .succeeded)
        // An older Hook without a label still names the pane.
        let unlabeled = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__phren_admin", input: input,
                                                            result: envelope(["ok": true, "delivered": true])))
        XCTAssertEqual(unlabeled.conductor, .handOff(target: "w1P:p2"))
        let failed = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__phren_admin", input: input,
                                                         result: #"{"ok":false,"error":"No live session with that id appears in the workspace overview."}"#))
        XCTAssertEqual(failed.status, .failed)
        XCTAssertEqual(failed.resultSummary, "No live session with that id appears in the workspace overview.")
    }

    func testDispatchShowsWhereItWentTheReceiptAndAFailuresReason() throws {
        let input = #"{"action":"dispatch","computer":"Mac.attlocal.net","project":"phren","harness":"claude","model":"opus","label":"voice","prompt":"Long brief"}"#
        let accepted = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__phren_admin", input: input,
            result: envelope(["ok": true, "id": "f5a03ce0-6b9d-49be-a4ca-7227d7943d0b", "state": "accepted", "computer": "Mac.attlocal.net"])))
        XCTAssertEqual(accepted.verb, "Dispatch")
        XCTAssertEqual(accepted.project, "phren")
        XCTAssertEqual(accepted.fields.map(\.name), ["Computer", "Harness", "Model", "Label"])
        XCTAssertEqual(accepted.fields.map(\.value), ["Mac.attlocal.net", "claude", "opus", "voice"])
        XCTAssertEqual(accepted.resultSummary, "Accepted · receipt f5a03ce0")
        let refused = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__phren_admin", input: input,
            result: #"{"ok":false,"error":"Unknown computer. Add its verified connection to hooks.yaml."}"#))
        XCTAssertEqual(refused.status, .failed)
        XCTAssertEqual(refused.resultSummary, "Unknown computer. Add its verified connection to hooks.yaml.")
    }
}
