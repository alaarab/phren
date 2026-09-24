import XCTest
@testable import PhrenKit

final class AgentModelSwitchTests: XCTestCase {
    func testConfirmedModelAndEffortReply() throws {
        let receipt = try AgentModelSwitch.read(Data(#"{"ok":true,"model":"gpt-6-astra","name":"GPT-6-Astra","effort":"high"}"#.utf8))
        XCTAssertEqual(receipt.model, "gpt-6-astra")
        XCTAssertEqual(receipt.name, "GPT-6-Astra")
        XCTAssertEqual(receipt.effort, "high")
        let claude = try AgentModelSwitch.read(Data(#"{"ok":true,"model":"claude-opus-5-5","name":"Opus 5.5"}"#.utf8))
        XCTAssertNil(claude.effort)
    }

    func testMissingOrUnconfirmedReceiptCannotClaimSuccess() {
        for text in [#"{"ok":true}"#, #"{"ok":false,"model":"opus","name":"Opus 5.5"}"#,
                     #"{"ok":true,"model":"two models","name":"Opus"}"#, #"{"ok":true,"model":"opus","name":""}"#] {
            XCTAssertThrowsError(try AgentModelSwitch.read(Data(text.utf8)))
        }
    }
}
