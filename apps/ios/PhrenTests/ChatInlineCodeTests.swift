import XCTest
@testable import Phren

@MainActor
final class ChatInlineCodeTests: XCTestCase {
    func testInlineCodeRunsTakeTheThemeColourAndProseDoesNot() {
        let attributed = ChatRichTextDocument.inline("Run `lsof -Fpcn` in `~/Projects/phren` now")
        let tinted = ChatInlineCode.tinted(attributed)
        let code = tinted.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }
        XCTAssertEqual(code.count, 2)
        XCTAssertTrue(code.allSatisfy { $0.foregroundColor == PhrenTheme.chatInlineCode })
        let prose = tinted.runs.filter { $0.inlinePresentationIntent?.contains(.code) != true }
        XCTAssertTrue(prose.allSatisfy { $0.foregroundColor == nil }, "Only code spans are coloured")
        XCTAssertEqual(String(tinted.characters), "Run lsof -Fpcn in ~/Projects/phren now")
    }
    func testPlainTextIsReturnedUntouched() {
        let attributed = ChatRichTextDocument.inline("No code here")
        XCTAssertEqual(ChatInlineCode.tinted(attributed), attributed)
    }
}
