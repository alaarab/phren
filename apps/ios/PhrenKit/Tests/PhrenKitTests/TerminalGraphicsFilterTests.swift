import XCTest
@testable import PhrenKit

final class TerminalGraphicsFilterTests: XCTestCase {
    func testKittyFileAndLargeImagePayloadsAreDroppedAcrossEveryChunkBoundary() {
        let source = Array("before\u{1B}_Gt=f,a=T;/private/file\u{1B}\\after".utf8)
        for split in 0...source.count {
            var filter = TerminalGraphicsFilter()
            let output = filter.filter(Array(source[..<split])) + filter.filter(Array(source[split...]))
            XCTAssertEqual(String(decoding: output, as: UTF8.self), "beforeafter", "Split \(split)")
        }
        var filter = TerminalGraphicsFilter()
        XCTAssertTrue(filter.filter([0x1B, 0x5F, 0x47]).isEmpty)
        for _ in 0..<100 { XCTAssertTrue(filter.filter(Array(repeating: 0x61, count: 8_192)).isEmpty) }
        XCTAssertEqual(filter.filter([0x1B, 0x5C, 0x78]), [0x78])
    }
    func testEightBitAPCAndMixedTerminatorsAreDropped() {
        for (prefix, suffix) in [([UInt8(0x9F), 0x47], [UInt8(0x9C)]), ([0x9F, 0x47], [0x1B, 0x5C]), ([0x1B, 0x5F, 0x47], [0x9C])] {
            var filter = TerminalGraphicsFilter()
            let source = [UInt8(0x78)] + prefix + [0x61, 0x1B, 0x62] + suffix + [0x79]
            XCTAssertEqual(source.flatMap { filter.filter([$0]) }, [0x78, 0x79])
        }
        var disguised = TerminalGraphicsFilter()
        let source = Array("before\u{1B}\n_\n\tGt=f;file\u{1B}\\after".utf8)
        XCTAssertEqual(String(decoding: source.flatMap { disguised.filter([$0]) }, as: UTF8.self), "beforeafter")
    }
    func testOrdinaryEscapesNonGraphicsAPCAndUTF8PassThroughUnchanged() {
        let source = Array("\u{1B}[31mred\u{1B}[0m\u{1B}]8;;https://example.com\u{1B}\\Docs\u{1B}]8;;\u{1B}\\\u{1B}_Xharmless\u{1B}\\ßG💟Graphics".utf8)
        for split in 0...source.count {
            var filter = TerminalGraphicsFilter()
            XCTAssertEqual(filter.filter(Array(source[..<split])) + filter.filter(Array(source[split...])), source)
        }
    }
}
