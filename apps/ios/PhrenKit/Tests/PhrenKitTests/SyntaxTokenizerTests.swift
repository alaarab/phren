import XCTest
@testable import PhrenKit

final class SyntaxTokenizerTests: XCTestCase {
    private func kinds(_ line: String, _ language: SyntaxTokenizer.Language) -> [(String, SyntaxTokenizer.Kind)] {
        SyntaxTokenizer.tokenize(line, language: language).map { (String(line[$0.range]), $0.kind) }
    }

    func testDetectsLanguagesFromPathsAndFenceLabels() {
        XCTAssertEqual(SyntaxTokenizer.Language.detect("Sources/App/Theme.swift"), .swift)
        XCTAssertEqual(SyntaxTokenizer.Language.detect("scripts/deploy-phone.py"), .python)
        XCTAssertEqual(SyntaxTokenizer.Language.detect("ts"), .typescript)
        XCTAssertEqual(SyntaxTokenizer.Language.detect("bash"), .shell)
        XCTAssertEqual(SyntaxTokenizer.Language.detect("Makefile"), .plain)
        XCTAssertEqual(SyntaxTokenizer.Language.detect(nil), .plain)
    }

    func testSwiftLineTintsKeywordsTypesCallsStringsAndComments() {
        let tokens = kinds(#"let accent = Color(hex: 0xB994F4) // the theme's purple"#, .swift)
        XCTAssertEqual(tokens.first?.0, "let"); XCTAssertEqual(tokens.first?.1, .keyword)
        XCTAssertTrue(tokens.contains { $0 == ("Color", .function) || $0 == ("Color", .type) })
        XCTAssertTrue(tokens.contains { $0 == ("0xB994F4", .number) })
        XCTAssertTrue(tokens.contains { $0.0.hasPrefix("//") && $0.1 == .comment })
        // Nothing inside the comment is re-tinted as a keyword.
        XCTAssertFalse(tokens.contains { $0 == ("the", .keyword) })
    }

    func testStringsShieldTheirContents() {
        let tokens = kinds(#"print("if this were code", 12)"#, .python)
        XCTAssertEqual(tokens.map(\.0), ["print", "\"if this were code\"", "12"])
        XCTAssertEqual(tokens.map(\.1), [.keyword, .string, .number])
    }

    func testJsonKeysAndShellCommentsAndPlain() {
        XCTAssertEqual(kinds(#"  "content": "import Foundation", "count": 3"#, .json).map(\.1), [.attribute, .string, .attribute, .number])
        XCTAssertEqual(kinds("export PATH=/usr/bin # tools", .shell).map(\.0), ["export", "# tools"])
        XCTAssertTrue(kinds("anything at all", .plain).isEmpty)
        XCTAssertTrue(SyntaxTokenizer.tokenize("", language: .swift).isEmpty)
    }

    func testTokensNeverOverlapAndAreOrdered() {
        let line = #"func run(_ name: String) throws -> [Token] { return "x\"y" }"#
        let tokens = SyntaxTokenizer.tokenize(line, language: .swift)
        for (a, b) in zip(tokens, tokens.dropFirst()) { XCTAssertLessThanOrEqual(a.range.upperBound, b.range.lowerBound) }
    }
}
