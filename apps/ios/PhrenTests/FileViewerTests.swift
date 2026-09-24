import PhrenKit
import XCTest
@testable import Phren

@MainActor final class FileViewerTests: XCTestCase {
    func testViewerChoiceUsesExtensionAndContentType() {
        for (name, kind) in [("render.mp4", FilePreviewKind.video), ("voice.wav", .audio), ("design.pdf", .pdf),
                             ("README.md", .markdown), ("App.swift", .code), ("data.json", .json), ("data.csv", .csv),
                             ("photo.png", .image), ("notes.txt", .text), ("archive.zip", .file)] {
            XCTAssertEqual(FileViewer.kind(name: name, contentType: nil), kind)
        }
        XCTAssertEqual(FileViewer.kind(name: "download", contentType: "video/mp4"), .video)
        XCTAssertEqual(FileViewer.kind(name: "download", contentType: "audio/mpeg"), .audio)
        XCTAssertEqual(FileViewer.kind(name: "wrong.mp4", contentType: "application/pdf"), .pdf)
        XCTAssertEqual(FileViewer.kind(name: "download", contentType: "application/json"), .json)
    }
    func testPathsBecomeLinksOnlyAfterExistenceCheck() throws {
        let input = try AttributedString(markdown: "Open `video/render.mp4`, `/home/sam/project/report.pdf`, and [data](result.json). Also `Makefile` and video/output. Missing `missing.xyz` stays text. [Web](https://example.org/file.pdf).")
        let candidates = Set(FilePathLinks.candidates(input).map(\.path))
        XCTAssertTrue(candidates.isSuperset(of: ["video/render.mp4", "/home/sam/project/report.pdf", "result.json", "missing.xyz", "Makefile", "video/output"]))
        let pending = FilePathLinks.linked(input, existing: [])
        XCTAssertEqual(pending.runs.compactMap(\.link).count, 1)
        let checked = FilePathLinks.linked(input, existing: ["video/render.mp4", "result.json"])
        XCTAssertEqual(checked.runs.compactMap(\.link).filter { $0.scheme == "phren-file" }.count, 2)
        XCTAssertFalse(checked.runs.contains { $0.link?.absoluteString.contains("missing.xyz") == true })
    }
    func testFoldableJSONKeepsArraysAndBooleans() throws {
        let tree = try FileJSONNode.make(["nested": ["complete": true], "frames": [1, 2, 3]] as [String: Any], depth: 0)
        XCTAssertEqual(tree.children.map(\.0), ["frames", "nested"])
        XCTAssertEqual(tree.children[0].1.children.count, 3)
        XCTAssertEqual(tree.children[1].1.children.first?.1.summary, "true")
    }
    func testImageAttachmentsDoNotNeedAnExtension() throws {
        let attachment = try AgentAttachment(name: "Image 1", data: Data([1]), isImage: true)
        XCTAssertEqual(FileViewer(attachment: attachment).item.previewKind, .image)
    }

}
