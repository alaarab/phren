import PhrenKit
import SwiftUI
import XCTest
@testable import Phren

@MainActor final class CodeHighlightingTests: XCTestCase {
    private func source(lines: Int) -> String {
        (0..<lines).map { "let value\($0) = compute(\"row \($0)\", \($0)) // note \($0)" }.joined(separator: "\n")
    }

    func testRepeatedLinesAreColoredOnce() {
        let line = "func unique\(UUID().uuidString.prefix(8))() { return 42 }"
        let before = CodeHighlighting.cache.misses
        let first = CodeHighlighting.highlighted(line, language: .swift)
        let second = CodeHighlighting.highlighted(line, language: .swift)
        XCTAssertEqual(first, second)
        XCTAssertEqual(CodeHighlighting.cache.misses - before, 1)
        // Another language is another entry.
        _ = CodeHighlighting.highlighted(line, language: .typescript)
        XCTAssertEqual(CodeHighlighting.cache.misses - before, 2)
    }

    func testBlockMatchesLineByLineColoring() {
        let code = "let a = 1\n// two\nlet b = \"three\""
        var expected = AttributedString()
        for (index, line) in code.components(separatedBy: "\n").enumerated() {
            if index > 0 { expected += AttributedString("\n") }
            expected += CodeHighlighting.highlighted(line, language: .swift)
        }
        XCTAssertEqual(CodeHighlighting.highlightedBlock(code, language: .swift), expected)
        XCTAssertEqual(CodeHighlighting.highlightedBlock(code, language: .plain), AttributedString(code))
    }

    /// A 2,000-line file on a phone-sized screen colors about a screenful of
    /// lines, and rendering it again colors none. Before, every render
    /// colored all 2,000.
    func testCodeViewColorsOnlyVisibleLinesAndCachesThem() {
        CodeHighlighting.cache.removeAll()
        let code = source(lines: 2_000)
        let host = UIHostingController(rootView: ScrollView([.horizontal, .vertical]) {
            CodeTextView(code: code, language: .swift)
        })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        window.rootViewController = host
        window.makeKeyAndVisible()
        let before = CodeHighlighting.cache.misses
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        let firstRender = CodeHighlighting.cache.misses - before
        XCTAssertGreaterThan(firstRender, 10)
        XCTAssertLessThan(firstRender, 200, "Only the lines on screen are colored")
        host.rootView = ScrollView([.horizontal, .vertical]) { CodeTextView(code: code, language: .swift) }
        host.view.setNeedsLayout(); host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        XCTAssertEqual(CodeHighlighting.cache.misses - before, firstRender, "A second render colors nothing new")
        print(String(format: "PHREN_PERF code-view-first-render-lines=%d of 2000", firstRender))
        window.isHidden = true
        // What every render used to cost: coloring all 2,000 lines.
        CodeHighlighting.cache.removeAll()
        let started = CFAbsoluteTimeGetCurrent()
        for line in code.components(separatedBy: "\n") { _ = CodeHighlighting.highlighted(line, language: .swift) }
        print(String(format: "PHREN_PERF code-view-color-all-2000-ms=%.1f", (CFAbsoluteTimeGetCurrent() - started) * 1_000))
        let again = CFAbsoluteTimeGetCurrent()
        for line in code.components(separatedBy: "\n") { _ = CodeHighlighting.highlighted(line, language: .swift) }
        print(String(format: "PHREN_PERF code-view-cached-all-2000-ms=%.1f", (CFAbsoluteTimeGetCurrent() - again) * 1_000))
    }
}
