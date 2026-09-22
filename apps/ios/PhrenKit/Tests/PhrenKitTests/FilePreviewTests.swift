import Foundation
import XCTest
@testable import PhrenKit

final class FilePreviewTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("file-preview-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    func testChunkAssemblyResumesAfterRecreationAndChangesRestart() async throws {
        let dir = try directory()
        let bytes = Data((0..<(9 * 1024 * 1024 + 17)).map { UInt8($0 % 251) })
        let info = FileChunk(offset: 0, total: Int64(bytes.count), contentType: "video/mp4", version: "v1", bytes: Data())
        let first = FileChunkAssembly(directory: dir, name: "render.mp4")
        let initial = try await first.prepare(info); XCTAssertEqual(initial, 0)
        let head = FileChunk(offset: 0, total: info.total, contentType: info.contentType, version: info.version, bytes: bytes.prefix(FileChunk.maximumLength))
        let firstSize = try await first.append(head); XCTAssertEqual(firstSize, Int64(FileChunk.maximumLength))
        let resumed = FileChunkAssembly(directory: dir, name: "render.mp4")
        var offset = try await resumed.prepare(info)
        XCTAssertEqual(offset, firstSize)
        while offset < info.total {
            let end = min(bytes.count, Int(offset) + FileChunk.maximumLength)
            offset = try await resumed.append(FileChunk(offset: offset, total: info.total, contentType: info.contentType, version: info.version,
                                                       bytes: bytes[Int(offset)..<end]))
        }
        let file = resumed.file
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        let again = try await resumed.prepare(info); XCTAssertEqual(again, info.total)
        let changed = try await resumed.prepare(FileChunk(offset: 0, total: 3, contentType: "video/mp4", version: "v2", bytes: Data()))
        XCTAssertEqual(changed, 0)
    }
    func testOutOfOrderAndChangedChunksAreRejectedWithoutWriting() async throws {
        let assembly = FileChunkAssembly(directory: try directory(), name: "file")
        _ = try await assembly.prepare(FileChunk(offset: 0, total: 10, contentType: "text/plain", version: "a", bytes: Data()))
        for chunk in [FileChunk(offset: 1, total: 10, contentType: "text/plain", version: "a", bytes: Data([1])),
                      FileChunk(offset: 0, total: 10, contentType: "text/plain", version: "b", bytes: Data([1])),
                      FileChunk(offset: 0, total: 10, contentType: "text/plain", version: "a", bytes: Data())] {
            do { _ = try await assembly.append(chunk); XCTFail("Must reject invalid chunks") } catch {}
        }
        let received = try await assembly.received(); XCTAssertEqual(received, 0)
        let invalid = Data(#"{"offset":0,"length":2,"total":2,"contentType":"text/plain","version":"a","eof":true,"data":"eA=="}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(FileChunk.self, from: invalid).bytes())
    }
    func testTypeDetectionPrefersSpecificMIMEAndFallsBackToExtension() {
        let examples: [(String, String?, FilePreviewKind)] = [
            ("render.MP4", nil, .video), ("sound.m4a", "application/octet-stream", .audio),
            ("download", "application/pdf", .pdf), ("readme.md", "text/plain", .markdown),
            ("app.swift", nil, .code), ("data.json", nil, .json), ("data.bin", "application/problem+json", .json),
            ("table.csv", nil, .csv), ("photo.heic", nil, .image), ("notes.log", nil, .text),
            ("archive.zip", nil, .file), ("misleading.mp4", "application/pdf; charset=binary", .pdf),
        ]
        for (name, mime, kind) in examples { XCTAssertEqual(FilePreviewKind.detect(name: name, contentType: mime), kind, name) }
    }
    func testUTF8PagesKeepSplitCharactersAndNeverLoadTheWholeText() throws {
        let url = try directory().appendingPathComponent("large.txt")
        let original = String(repeating: "a世界👋\n", count: 1000)
        try Data(original.utf8).write(to: url)
        var cursor = FileTextCursor(), output = ""
        while true {
            let page = try FileTextPage.read(url: url, cursor: cursor, limit: 101)
            XCTAssertLessThanOrEqual(page.next.offset - cursor.offset, 101)
            output += page.text; cursor = page.next
            if page.eof { break }
        }
        XCTAssertEqual(output, original)
    }
    func testStreamingJSONPreservesQuotedPunctuationAcrossPages() throws {
        let url = try directory().appendingPathComponent("data.json")
        let original = #"{"message":"braces { and } commas, quote \" and unicode 世界","list":[1,2,true,null]}"#
        try Data(original.utf8).write(to: url)
        var cursor = FileTextCursor(), output = ""
        while true {
            let page = try FileTextPage.read(url: url, cursor: cursor, json: true, limit: 11)
            output += page.text; cursor = page.next
            if page.eof { break }
        }
        XCTAssertTrue(output.contains("\n"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(output.utf8)) as? NSDictionary,
                       try JSONSerialization.jsonObject(with: Data(original.utf8)) as? NSDictionary)
    }
    func testCSVQuotedRecordsAndPagination() throws {
        let url = try directory().appendingPathComponent("table.csv")
        let text = "name,detail\r\n\"sam\",\"comma, quote \"\" and\nnewline\"\r\n" + String(repeating: "a,b\n", count: 201)
        try Data(text.utf8).write(to: url)
        var offset: UInt64 = 0, rows: [[String]] = []
        while true {
            let page = try FileCSVPage.read(url: url, offset: offset)
            rows += page.rows; offset = page.nextOffset
            if page.eof { break }
        }
        XCTAssertEqual(rows.count, 203)
        XCTAssertEqual(rows[1], ["sam", "comma, quote \" and\nnewline"])
    }
    func testInvalidTrailingUTF8IsNotSilentlyDropped() throws {
        let url = try directory().appendingPathComponent("invalid.txt")
        try Data([65, 0xE2, 0x82]).write(to: url)
        XCTAssertThrowsError(try FileTextPage.read(url: url, cursor: FileTextCursor()))
    }

    func testExactPageBoundariesDoNotOfferAnEmptyNextPage() throws {
        let url = try directory().appendingPathComponent("exact.txt")
        try Data("abcdefgh".utf8).write(to: url)
        XCTAssertTrue(try FileTextPage.read(url: url, cursor: FileTextCursor(), limit: 8).eof)
        try Data("a,b\n".utf8).write(to: url)
        let csv = try FileCSVPage.read(url: url, offset: 0, maximumBytes: 4)
        XCTAssertTrue(csv.eof)
        XCTAssertEqual(csv.rows, [["a", "b"]])
    }

}
