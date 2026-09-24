import XCTest
import PhrenKit
@testable import Phren

/// Web fetches, skills and other MCP servers in the timeline: which get a
/// card, and which still fold with the reads around them.
final class ToolCardTimelineTests: XCTestCase {
    func testThreeFetchesFoldLikeReadsAndKeepTheirCardsWhenExpanded() throws {
        var raws: [[String: Any]] = []
        for index in 0..<3 {
            raws.append(["type": "response_item", "payload": ["type": "function_call", "call_id": "f\(index)", "name": "WebFetch", "arguments": "{\"url\":\"https://example.org/page/\(index)\",\"prompt\":\"Read it\"}"]])
            raws.append(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "f\(index)", "output": "Page \(index)"]])
        }
        raws.append(["type": "response_item", "payload": ["type": "function_call", "call_id": "s", "name": "WebSearch", "arguments": "{\"query\":\"swiftui\"}"]])
        raws.append(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "s", "output": "Web search results for query: \"swiftui\""]])
        let folded = ChatTimelineEntry.group(try read(raws))
        XCTAssertEqual(folded.map(\.isReadRun), [true], "Fetches and a search are looking around: they fold")
        let expanded = ChatTimelineEntry.group(folded[0].messages, foldingReads: false)
        XCTAssertEqual(expanded.count, 4)
        guard case .web(let fetch)? = expanded.first?.card, case .web(let search)? = expanded.last?.card else { return XCTFail("Web cards inside the run") }
        XCTAssertEqual(fetch.location, "example.org/page/0"); XCTAssertEqual(search.location, "“swiftui”")
        XCTAssertNotNil(WebToolCard.presentation(expanded[0].messages), "The row draws the card from its messages")
        XCTAssertNil(WebToolCard.presentation(expanded[0].messages.suffix(1).map { $0 }), "A result alone is no card")
        // A fetch still out keeps its own card either side of the reads.
        let pending = ChatTimelineEntry.group(try read(Array(raws.dropLast())))
        XCTAssertEqual(pending.map(\.isReadRun), [true, false])
        XCTAssertEqual(pending.last?.card.map { if case .web(let web) = $0 { return web.status == .running } else { return false } }, true)
    }

    func testASkillCallEndsTheRunAndIsAChipNotAPill() throws {
        var raws: [[String: Any]] = []
        for index in 0..<7 {
            if index == 3 {
                raws.append(["type": "response_item", "payload": ["type": "function_call", "call_id": "skill", "name": "Skill", "arguments": "{\"skill\":\"design\",\"args\":\"the cards\"}"]])
                raws.append(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "skill", "output": "Launching skill: design"]])
            }
            raws.append(["type": "response_item", "payload": ["type": "function_call", "call_id": "r\(index)", "name": "Read", "arguments": "{\"file_path\":\"/work/\(index).swift\"}"]])
            raws.append(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "r\(index)", "output": "ok"]])
        }
        let entries = ChatTimelineEntry.group(try read(raws))
        XCTAssertEqual(entries.map(\.isReadRun), [true, false, true], "The skill is a visible event: reads fold either side of it")
        guard entries.count == 3, case .skill(let skill)? = entries[1].card else { return XCTFail("A skill chip") }
        XCTAssertEqual(skill.command, "/design"); XCTAssertEqual(skill.args, "the cards")
        XCTAssertTrue(ToolCardKind.interruptsRun("Skill")); XCTAssertTrue(ToolCardKind.interruptsRun("mcp__github__get_issue"))
        XCTAssertFalse(ToolCardKind.interruptsRun("WebFetch")); XCTAssertFalse(ToolCardKind.interruptsRun("WebSearch"))
        XCTAssertFalse(ToolCardKind.interruptsRun("Read"))
        // A Skill call that names no skill gets no chip and no card: the pill shows the raw call.
        let bare = ChatTimelineEntry.group(try read([["type": "response_item", "payload": ["type": "function_call", "call_id": "x", "name": "Skill", "arguments": "{}"]]]))
        XCTAssertNil(bare[0].card); XCTAssertTrue(bare[0].isActivity)
    }

    func testOtherServersGetMCPCardsAndNeverFoldWhilePhrenKeepsItsOwn() throws {
        var raws: [[String: Any]] = []
        for (index, name) in ["mcp__github__get_pull_request", "mcp__herdr__list_panes", "mcp__github__merge_pull_request"].enumerated() {
            raws.append(["type": "response_item", "payload": ["type": "function_call", "call_id": "m\(index)", "name": name, "arguments": "{\"owner\":\"alaarab\",\"repo\":\"phren\",\"labels\":[\"ios\"]}"]])
            raws.append(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "m\(index)", "output": index == 2 ? "{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"Not mergeable\"}]}" : "{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"title\\\":\\\"Cards\\\",\\\"state\\\":\\\"open\\\"}\"}]}"]])
        }
        raws.append(["type": "response_item", "payload": ["type": "function_call", "call_id": "p", "name": "mcp__phren__add_task", "arguments": "{\"task\":\"Verify\"}"]])
        raws.append(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "p", "output": "{\"ok\":true}"]])
        let entries = ChatTimelineEntry.group(try read(raws))
        XCTAssertFalse(entries.contains(where: \.isReadRun), "MCP calls are events, not looking around")
        XCTAssertEqual(entries.count, 4)
        guard entries.count == 4, case .mcp(let pull)? = entries[0].card, case .mcp(let merge)? = entries[2].card else { return XCTFail("MCP cards") }
        XCTAssertEqual(pull.server, "GitHub"); XCTAssertEqual(pull.verb, "Get pull request")
        XCTAssertEqual(pull.resultLines, ["title: Cards", "state: open"]); XCTAssertEqual(pull.status, .succeeded)
        XCTAssertEqual(pull.fields.map(\.value), ["1 item", "alaarab", "phren"])
        XCTAssertEqual(merge.status, .failed); XCTAssertEqual(merge.resultLines, ["Not mergeable"])
        XCTAssertNotNil(entries[3].phren); XCTAssertNil(entries[3].card, "Phren's card is untouched")
        XCTAssertNotNil(MCPToolCard.presentation(entries[1].messages)); XCTAssertNil(MCPToolCard.presentation(entries[3].messages))
        XCTAssertNotNil(SkillChip.presentation(ChatTimelineEntry.group(try read([["type": "response_item", "payload": ["type": "function_call", "call_id": "k", "name": "Skill", "arguments": "{\"skill\":\"video\"}"]]]))[0].messages))
    }

    private func read(_ raws: [[String: Any]]) throws -> [AgentChatMessage] {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "codex", "totalLines": raws.count,
            "entries": raws.enumerated().map { ["line": $0.offset, "raw": $0.element] }]), source: "codex").messages
    }
}
