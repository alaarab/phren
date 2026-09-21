import Foundation
import XCTest
@testable import PhrenKit

final class CodeIndexTests: XCTestCase {
    private let symbol = #"{"id":7,"name":"greet","kind":"function","file":"python/helpers.py","line":3,"endLine":5,"signature":"def greet(name: str) -> str","doc":"Say hello.","parent":null,"exported":true,"uses":2}"#

    func testDecodesAStatusWithLanguagesKindsAndTopSymbols() throws {
        let payload = #"""
        {"project":"fixture","available":true,"files":7,"symbols":24,"references":9,
         "lastIndexedAt":1758460000000,
         "languages":[{"language":"typescript","files":2},{"language":"swift","files":2}],
         "kinds":[{"kind":"function","symbols":10}],
         "top":[{"name":"add","file":"typescript/app.ts","kind":"function","line":1,"exported":true,"uses":4}]}
        """#
        let status = try CodeStatus.read(Data(payload.utf8))
        XCTAssertEqual(status.project, "fixture")
        XCTAssertTrue(status.available)
        XCTAssertEqual(status.symbols, 24)
        XCTAssertEqual(status.languages.first?.language, "typescript")
        XCTAssertEqual(status.kinds.first?.kind, "function")
        XCTAssertEqual(status.top.first?.uses, 4)
    }

    func testRejectsAnOversizedStatus() {
        let data = Data(repeating: 0x20, count: 1_048_577)
        XCTAssertThrowsError(try CodeStatus.read(data)) { error in
            XCTAssertEqual(error as? PhrenKitError, .validation("The code index status is too large."))
        }
    }

    func testDecodesASearchResult() throws {
        let payload = #"{"project":"fixture","query":"gr","symbols":[\#(symbol)]}"#
        let symbols = try CodeSearchResults.read(Data(payload.utf8))
        XCTAssertEqual(symbols.count, 1)
        XCTAssertEqual(symbols[0].name, "greet")
        XCTAssertEqual(symbols[0].kind, "function")
        XCTAssertEqual(symbols[0].uses, 2)
        XCTAssertEqual(symbols[0].location, "python/helpers.py:3")
        XCTAssertEqual(symbols[0].fileName, "helpers.py")
    }

    func testDecodesAnOutlineWithChildren() throws {
        let payload = #"""
        {"project":"fixture","path":"typescript/app.ts","entries":[
          {"name":"Point","kind":"class","line":4,"endLine":12,"signature":"class Point","doc":"","exported":true,"uses":3,
           "children":[{"name":"length","kind":"method","line":6,"endLine":8,"signature":"length()","doc":"","exported":false,"uses":1,"children":[]}]}
        ]}
        """#
        let entries = try CodeOutlineResults.read(Data(payload.utf8))
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].name, "Point")
        XCTAssertEqual(entries[0].children.first?.name, "length")
        XCTAssertEqual(entries[0].children.first?.id, "length#6")
    }

    func testDecodesADefinitionWithSnippetAndBlame() throws {
        let payload = #"{"project":"fixture","definition":{"symbol":\#(symbol),"candidates":1,"snippet":"def greet(name):\n    return name","blame":{"authorHash":"abc123","at":"2026-09-20T00:00:00Z"}}}"#
        let definition = try CodeDefinitionResults.read(Data(payload.utf8))
        XCTAssertEqual(definition.symbol.name, "greet")
        XCTAssertTrue(definition.snippet.contains("return name"))
        XCTAssertEqual(definition.blame?.authorHash, "abc123")
    }

    func testDecodesReferencesGroupedByFile() throws {
        let payload = #"{"project":"fixture","references":{"symbol":\#(symbol),"candidates":1,"total":2,"groups":[{"file":"typescript/util.ts","references":[{"line":3,"kind":"call"},{"line":9,"kind":"call"}]}]}}"#
        let references = try CodeReferencesResults.read(Data(payload.utf8))
        XCTAssertEqual(references.total, 2)
        XCTAssertEqual(references.groups.first?.file, "typescript/util.ts")
        XCTAssertEqual(references.groups.first?.references.count, 2)
        XCTAssertEqual(references.groups.first?.references.first?.kind, "call")
    }

    func testDecodesHotAndColdUsage() throws {
        let payload = #"{"project":"fixture","usage":{"hot":[{"name":"add","kind":"function","file":"typescript/app.ts","line":1,"exported":true,"uses":4}],"cold":[{"name":"Axis","kind":"type","file":"typescript/app.ts","line":20,"exported":true,"uses":0}]}}"#
        let usage = try CodeUsageResults.read(Data(payload.utf8))
        XCTAssertEqual(usage.hot.first?.name, "add")
        XCTAssertEqual(usage.cold.first?.uses, 0)
    }

    func testMissingOptionalFieldsDecodeToDefaults() throws {
        let minimal = try JSONDecoder().decode(CodeSymbol.self, from: Data(#"{"name":"x","kind":"function"}"#.utf8))
        XCTAssertEqual(minimal.uses, 0)
        XCTAssertFalse(minimal.exported)
        XCTAssertNil(minimal.parent)
    }

    func testCodeCapabilityGatesTheFeature() {
        let capabilities = try? JSONDecoder().decode(LiveCapabilities.self, from: Data(#"{"code":true}"#.utf8))
        XCTAssertEqual(capabilities?.allows(.code), true)
        let absent = try? JSONDecoder().decode(LiveCapabilities.self, from: Data("{}".utf8))
        XCTAssertEqual(absent?.allows(.code), false)
    }
}
