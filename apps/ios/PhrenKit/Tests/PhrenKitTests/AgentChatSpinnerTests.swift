import Foundation
import XCTest
@testable import PhrenKit

/// The `activity` objects below are what the Hook's parser produces for real
/// Claude spinner lines (packages/cli/src/bridge/transcript-preview.test.ts).
final class AgentChatSpinnerTests: XCTestCase {
    private func frame(_ activity: String, type: String = "preview") throws -> AgentChatTranscript {
        let preview = type == "preview" ? #","preview":null"# : #","entries":[]"#
        return try AgentChatTranscript.read(Data(#"{"type":"\#(type)","source":"claude","activityVerb":"Pondering"\#(preview),"activity":\#(activity)}"#.utf8), source: "claude")
    }

    func testRealSpinnerLinesDecode() throws {
        // ✢ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)
        let pondering = try frame(#"{"verb":"Pondering","elapsed":12,"tokens":{"count":1200,"direction":"up"},"thinking":false}"#).activity
        XCTAssertEqual(pondering, AgentChatSpinner(verb: "Pondering", elapsed: 12, tokens: 1200, direction: .up))
        XCTAssertEqual(pondering?.details, ["↑ 1.2k tokens"])
        // ✽ Precipitating… (49s · thought for 4s)
        let precipitating = try frame(#"{"verb":"Precipitating","elapsed":49,"thinking":false,"thoughtFor":4}"#, type: "append").activity
        XCTAssertEqual(precipitating, AgentChatSpinner(verb: "Precipitating", elapsed: 49, thoughtFor: 4))
        XCTAssertEqual(precipitating?.details, ["thought for 4s"])
        // ✢ Crunching… (26s · ↓ 864 tokens)
        let crunching = try frame(#"{"verb":"Crunching","elapsed":26,"tokens":{"count":864,"direction":"down"},"thinking":false}"#).activity
        XCTAssertEqual(crunching?.details, ["↓ 864 tokens"])
        // * Whirlpooling… (27s · ↓ 2.3k tokens · thinking)
        let whirlpooling = try frame(#"{"verb":"Whirlpooling","elapsed":27,"tokens":{"count":2300,"direction":"down"},"thinking":true}"#).activity
        XCTAssertEqual(whirlpooling, AgentChatSpinner(verb: "Whirlpooling", elapsed: 27, tokens: 2300, direction: .down, thinking: true))
        XCTAssertEqual(whirlpooling?.details, ["↓ 2.3k tokens", "thinking"])
        // "✻ Working… (esc to interrupt)" carries only the verb.
        XCTAssertEqual(try frame(#"{"verb":"Working","thinking":false}"#).activity?.details, [])
    }

    func testMalformedActivityIsDroppedButTheFrameAndVerbSurvive() throws {
        for bad in [#"{"verb":"rm -rf /"}"#, #"{"verb":"Pondering","elapsed":"12"}"#, #"{"verb":"Pondering","elapsed":-1}"#,
                    #"{"verb":"Pondering","tokens":{"count":12}}"#, #"{"verb":"Pondering","tokens":{"count":1,"direction":"sideways"}}"#,
                    #"{"verb":"Pondering","thinking":1}"#, #"{"verb":"Pondering","elapsed":true}"#, #""Pondering""#] {
            let value = try frame(bad)
            XCTAssertNil(value.activity, bad)
            XCTAssertEqual(value.activityVerb, "Pondering")
        }
        // An older Hook sends only the verb.
        let older = try AgentChatTranscript.read(Data(#"{"type":"append","source":"claude","activityVerb":"Pondering","entries":[]}"#.utf8), source: "claude")
        XCTAssertNil(older.activity)
    }

    func testPastTenseForTheFinishedLine() {
        XCTAssertEqual(AgentChatSpinner.pastTense("Brewing"), "Brewed")
        XCTAssertEqual(AgentChatSpinner.pastTense("Whirlpooling"), "Whirlpooled")
        XCTAssertEqual(AgentChatSpinner.pastTense("Spinning"), "Spun")
        XCTAssertNil(AgentChatSpinner.pastTense("Zorbling"))
    }
}

/// Claude's narration arrives from the Hook as a text block marked
/// `narration: true` (transcript-claude.ts `visibleClaudeEvent`).
final class AgentChatNarrationTests: XCTestCase {
    func testNarrationFlagSurvivesDecodingAndTheReplyStaysPlain() throws {
        let data = Data(#"{"type":"backlog","source":"claude","entries":[{"line":3,"raw":{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Checking the tests next.","narration":true},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}},{"type":"text","text":"All green."}]}}}]}"#.utf8)
        let frame = try AgentChatTranscript.read(data, source: "claude")
        XCTAssertEqual(frame.messages.map(\.role), [.assistant, .tool, .assistant])
        XCTAssertEqual(frame.messages.first?.text, "Checking the tests next.")
        XCTAssertEqual(frame.messages.map(\.isNarration), [true, false, false])
        // A user row can never claim narration.
        let user = try AgentChatTranscript.read(Data(#"{"type":"backlog","source":"claude","entries":[{"line":1,"raw":{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hi","narration":true}]}}}]}"#.utf8), source: "claude")
        XCTAssertEqual(user.messages.map(\.isNarration), [false])
    }
}
