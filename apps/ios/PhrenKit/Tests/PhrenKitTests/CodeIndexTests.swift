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

extension CodeIndexTests {
    func testCodeNoteRequestAndPartialDeliveryResponse() throws {
        let request = CodeNoteRequest(project: "demo", symbol: "Point", file: "point.ts", line: 8, text: "Keep coordinates stable.", target: .init(harness: "codex"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(body["line"] as? Int, 8)
        XCTAssertEqual(body["target"] as? [String: String], ["harness": "codex"])
        let response = try JSONDecoder().decode(CodeNoteResult.self, from: Data(#"{"ok":true,"saved":true,"findings":[{"id":"L1","text":"Keep coordinates stable.","symbol":"Point"}],"delivery":{"ok":false,"message":"Offline"}}"#.utf8))
        XCTAssertTrue(response.saved)
        XCTAssertEqual(response.findings.first?.symbol, "Point")
        XCTAssertEqual(response.delivery?.confirmed, false)
        XCTAssertEqual(response.delivery?.message, "Offline")
    }
}


extension CodeIndexTests {
    func testSessionNoteRetainsStoreAndExactRecipient() throws {
        let request = CodeNoteRequest(project: "phone", symbol: "file.ts::Point", file: "file.ts", line: 5,
                                      text: "Keep coordinates stable.", target: .init(session: "session-one"), store: "sam/brain")
        let data = try JSONEncoder().encode(request)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["store"] as? String, "sam/brain")
        XCTAssertEqual(body["target"] as? [String: String], ["session": "session-one"])
    }
    func testChangeCountsDecodeTheHookShapeAndReadAsChips() throws {
        // The shape /v1/code/change-counts returns (packages/cli code-routes.test.ts).
        let json = #"{"project":"fixture","entries":[{"path":"typescript/app.ts","functions":{"changed":1,"added":0},"types":{"changed":0,"added":0},"first":"typescript/app.ts::add"},{"path":"typescript/extra.ts","functions":{"changed":0,"added":1},"types":{"changed":0,"added":1},"first":"typescript/extra.ts::Extra"},{"path":"README.md","functions":{"changed":0,"added":0},"types":{"changed":0,"added":0}}]}"#
        let entries = try CodeChangeCountResults.read(Data(json.utf8))
        XCTAssertEqual(entries.map(\.label), ["1 function changed", "1 new function · 1 new type", nil])
        XCTAssertEqual(entries[0].first, "typescript/app.ts::add")
        let many = CodeChangeCount(path: "a.swift", functions: .init(changed: 2, added: 3), types: .init(changed: 2, added: 0), first: nil)
        XCTAssertEqual(many.label, "2 functions changed · 3 new functions · 2 types changed")
        XCTAssertThrowsError(try CodeChangeCountResults.read(Data(json.replacingOccurrences(of: "\"changed\":1", with: "\"changed\":-1").utf8)))
    }
    func testApprovalKeepsProviderOptionOrderAndCommandSeparate() throws {
        let data = Data(#"{"actionId":"ask","message":"{\"command\":\"pnpm test\",\"justification\":\"Check the change\"}","options":[{"label":"Yes","decision":"approve"},{"label":"Yes and allow this project","decision":"allow-project"},{"label":"No","decision":"deny"}]}"#.utf8)
        let approval = try JSONDecoder().decode(AgentApproval.self, from: data)
        XCTAssertEqual(approval.options?.map(\.label), ["Yes", "Yes and allow this project", "No"])
        XCTAssertEqual(approval.command, "pnpm test")
        XCTAssertEqual(approval.explanation, "Check the change")
    }
}

extension CodeIndexTests {
    func testDecodesIndexedTreeWithEmptyFilesAndDirectoryTotals() throws {
        let json = #"{"project":"demo","directory":"","entries":[{"path":"src","directory":true,"files":2,"symbols":8,"languages":["swift","typescript"]},{"path":"empty.ts","directory":false,"files":1,"symbols":0,"languages":["typescript"]}]}"#
        let tree = try CodeTreeResults.read(Data(json.utf8))
        XCTAssertEqual(tree[0].files, 2)
        XCTAssertEqual(tree[0].languages, ["swift", "typescript"])
        XCTAssertTrue(tree[0].directory)
        XCTAssertEqual(tree[1].symbols, 0)
        XCTAssertThrowsError(try CodeTreeResults.read(Data(json.replacingOccurrences(of: "\"symbols\":8", with: "\"symbols\":-1").utf8)))
    }

    func testDecodesUsagePagesWithGlobalRanksAndBounds() throws {
        let json = #"{"project":"demo","entries":[\#(symbol)],"total":51,"offset":50,"limit":50,"maxUses":10}"#
        let page = try CodeUsagePage.read(Data(json.utf8))
        XCTAssertEqual(page.entries.first?.qualifiedName, "python/helpers.py::greet")
        XCTAssertTrue(page.hasPrevious)
        XCTAssertFalse(page.hasNext)
        XCTAssertEqual(page.maxUses, 10)
        XCTAssertThrowsError(try CodeUsagePage.read(Data(json.replacingOccurrences(of: "\"offset\":50", with: "\"offset\":-1").utf8)))
        XCTAssertThrowsError(try CodeUsagePage.read(Data(json.replacingOccurrences(of: "\"limit\":50", with: "\"limit\":101").utf8)))
        XCTAssertThrowsError(try CodeUsagePage.read(Data(json.replacingOccurrences(of: "\"maxUses\":10", with: "\"maxUses\":1").utf8)))
        let empty = try CodeUsagePage.read(Data(#"{"entries":[],"total":0,"offset":0,"limit":50,"maxUses":0}"#.utf8))
        XCTAssertFalse(empty.hasNext)
        XCTAssertFalse(empty.hasPrevious)
    }

    func testWhatChangedDecodesTheHookShapeByFileAndFamily() throws {
        // The shape /v1/code/changed returns (packages/cli code-routes.test.ts).
        let json = #"{"project":"fixture","files":[{"path":"typescript/app.ts","items":[{"name":"add","kind":"function","family":"function","file":"typescript/app.ts","line":2,"endLine":4,"parent":null,"isNew":false,"uses":3},{"name":"length","kind":"method","family":"function","file":"typescript/app.ts","line":11,"endLine":13,"parent":"Point","isNew":true,"uses":0}]}]}"#
        let files = try CodeChangedResults.read(Data(json.utf8))
        XCTAssertEqual(files.map(\.path), ["typescript/app.ts"])
        XCTAssertEqual(files[0].items.map(\.qualifiedName), ["typescript/app.ts::add", "typescript/app.ts::Point.length"])
        XCTAssertEqual(files[0].items.map(\.isNew), [false, true])
        XCTAssertThrowsError(try CodeChangedResults.read(Data(json.replacingOccurrences(of: "\"endLine\":4", with: "\"endLine\":1").utf8)))
        let member = try JSONDecoder().decode(CodeSymbol.self, from: Data(symbol.replacingOccurrences(of: "null", with: "\"Helpers\"").utf8))
        XCTAssertEqual(member.qualifiedName, "python/helpers.py::Helpers.greet")
    }

    func testFileReferencesMarkWholeIdentifiersWithTheirDeclarations() throws {
        let json = #"{"project":"demo","path":"src/util.ts","references":[{"line":5,"kind":"call","name":"add","symbol":"src/app.ts::add","file":"src/app.ts","targetLine":2,"targetKind":"function"}]}"#
        let references = try CodeFileReferenceResults.read(Data(json.utf8))
        XCTAssertThrowsError(try CodeFileReferenceResults.read(Data(json.replacingOccurrences(of: "src/app.ts::add", with: "other.ts::add").utf8)))
        XCTAssertThrowsError(try CodeFileReferenceResults.read(Data(json.replacingOccurrences(of: "\"line\":5", with: "\"line\":0").utf8)))
        let outline = [CodeOutlineEntry(name: "double", kind: "function", line: 4, endLine: 6, signature: "", doc: "", exported: true, uses: 1, children: [])]
        let symbols = CodeFileSymbols(path: "src/util.ts", outline: outline, references: references)
        let uses = symbols.occurrences(in: "  return add(value, addend) + add(1, 2);", line: 5)
        XCTAssertEqual(uses.map(\.range.location), [9, 30])
        XCTAssertEqual(uses.first?.target.symbol, "src/app.ts::add")
        XCTAssertEqual(uses.first?.target.line, 2)
        XCTAssertEqual(symbols.occurrences(in: "export function double(value: number) {", line: 4).first?.target.symbol, "src/util.ts::double")
        XCTAssertTrue(symbols.occurrences(in: "add", line: 9).isEmpty)
    }

    func testSourceTextDecodesUTF8SplitsLinesAndRejectsBinary() {
        XCTAssertEqual(CodeSourceText.lines("a\r\nb\n"), ["a", "b"])
        XCTAssertEqual(CodeSourceText.lines(""), [""])
        XCTAssertNil(CodeSourceText.decode(Data([0x61, 0x00, 0x62])))
        XCTAssertNil(CodeSourceText.decode(Data([0xFF, 0xFE, 0xFD])))
        XCTAssertEqual(CodeSourceText.decode(Data("é".utf8)), "é")
        XCTAssertTrue(CodeSourceText.opensAsSource(.code))
        XCTAssertTrue(CodeSourceText.opensAsSource(.file))
        XCTAssertFalse(CodeSourceText.opensAsSource(.image))
        XCTAssertFalse(CodeSourceText.opensAsSource(.pdf))
    }
}
