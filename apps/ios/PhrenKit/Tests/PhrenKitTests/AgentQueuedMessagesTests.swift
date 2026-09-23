import XCTest
@testable import PhrenKit

final class AgentQueuedMessagesTests: XCTestCase {
    func testFooterAndItsPathsAreDroppedButTextAfterThemIsKept() {
        // Claude joined two queued sends into one turn: the second message
        // follows the first one's attachment footer directly.
        let merged = "[Image #1]Not sure why this shows as unsent\n\nAttached files on this computer:I want dispatch to work here too"
        XCTAssertEqual(AgentQueuedMessages.normalizedText(merged), "Not sure why this shows as unsent I want dispatch to work here too")
    }

    func testFooterWithPathsLeavesOnlyTheMessage() {
        let sent = "Look at this header\n\nAttached files on this computer:\n/home/sam/.phren/uploads/a.png\n~/shots/b.png\n"
        XCTAssertEqual(AgentQueuedMessages.normalizedText(sent), "Look at this header")
    }

    func testPlainTextIsWhitespaceNormalized() {
        XCTAssertEqual(AgentQueuedMessages.normalizedText("  one\n\ntwo   three "), "one two three")
        XCTAssertEqual(AgentQueuedMessages.normalizedText("[Image #3]"), "")
    }
}
