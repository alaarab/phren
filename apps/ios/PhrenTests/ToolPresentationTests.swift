import XCTest
@testable import Phren

final class ToolPresentationTests: XCTestCase {
    private func json(_ value: Any) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    func testWriteBecomesANewFilePatchNamedByItsShortPath() {
        let write = ToolPresentation(title: "Write", text: json(["file_path": "/Users/me/app/Sources/Theme.swift", "content": "import SwiftUI\nlet accent = purple"]))
        XCTAssertEqual(write.title, "Write")
        XCTAssertEqual(write.patch, "*** Add File: /Users/me/app/Sources/Theme.swift\n+import SwiftUI\n+let accent = purple")
        XCTAssertEqual(write.preview, "Sources/Theme.swift")
        let document = DiffDocument(patch: write.patch!)
        XCTAssertEqual(document.added, 2); XCTAssertEqual(document.removed, 0)
        XCTAssertEqual(document.rows.first?.text, "New file · /Users/me/app/Sources/Theme.swift")
        XCTAssertEqual(document.rows.last?.new, 2)
    }

    func testMultiEditBecomesOneHunkPerEdit() {
        let edit = ToolPresentation(title: "MultiEdit", text: json(["file_path": "/app/Theme.swift", "edits": [
            ["old_string": "let a = 1", "new_string": "let a = 2"],
            ["old_string": "let b = 1\nlet c = 1", "new_string": "let b = 3"],
        ]]))
        XCTAssertEqual(edit.title, "Patch")
        XCTAssertEqual(edit.patch, "*** Update File: /app/Theme.swift\n@@\n-let a = 1\n+let a = 2\n@@\n-let b = 1\n-let c = 1\n+let b = 3")
        let document = DiffDocument(patch: edit.patch!)
        XCTAssertEqual(document.changeStarts.count, 2)
        XCTAssertEqual(document.added, 2); XCTAssertEqual(document.removed, 3)
    }

    func testClaudeCodeReadsSearchesAndTodosSummarize() {
        let read = ToolPresentation(title: "Read", text: json(["file_path": "/app/Sources/Theme.swift", "offset": 10, "limit": 40]))
        XCTAssertEqual(read.title, "Read")
        XCTAssertEqual(read.preview, "Sources/Theme.swift · lines 10–49")
        XCTAssertNil(read.patch)
        let grep = ToolPresentation(title: "Grep", text: json(["pattern": "accent", "path": "/app/Sources"]))
        XCTAssertEqual(grep.title, "Grep"); XCTAssertEqual(grep.preview, "accent in app/Sources")
        let glob = ToolPresentation(title: "Glob", text: json(["pattern": "**/*.swift"]))
        XCTAssertEqual(glob.preview, "**/*.swift")
        let fetch = ToolPresentation(title: "WebFetch", text: json(["url": "https://example.com/doc", "prompt": "summarize"]))
        XCTAssertEqual(fetch.title, "Fetch"); XCTAssertEqual(fetch.preview, "https://example.com/doc")
        let todos = ToolPresentation(title: "TodoWrite", text: json(["todos": [["content": "Ship it", "status": "completed"], ["content": "Test it", "status": "in_progress"], ["content": "Doc it", "status": "pending"]]]))
        XCTAssertEqual(todos.title, "Todos"); XCTAssertEqual(todos.body, "☑ Ship it\n◐ Test it\n☐ Doc it")
        let agent = ToolPresentation(title: "Task", text: json(["description": "Audit the sync loop", "prompt": "Long prompt…"]))
        XCTAssertEqual(agent.title, "Agent"); XCTAssertEqual(agent.preview, "Audit the sync loop")
    }

    func testOutputPreviewBoundsAreConfigurable() {
        let output = (0..<100).map { "line \($0)" }.joined(separator: "\n")
        XCTAssertEqual(ToolOutputPreview(output).text.components(separatedBy: "\n").count, 6)
        XCTAssertEqual(ToolOutputPreview(output, lines: 80, characters: 16_000).text.components(separatedBy: "\n").count, 80)
        XCTAssertTrue(ToolOutputPreview(output, lines: 80, characters: 16_000).text.hasSuffix("…"))
        XCTAssertEqual(ToolOutputPreview(output, lines: 200, characters: 16_000).text, output)
    }

    func testShellEditsNameThePathsTheyTouch() {
        // A python heredoc that writes under the phren store and appends a file: the
        // paths it names come out, system paths and URLs do not.
        let cmd = """
        python3 - <<'PY'
        from pathlib import Path
        p=Path('/Users/me/.phren/objectstudio/reference/live-midi')
        (p/'source-inputs.json').write_text('{}')
        with (p/'WORK.md').open('a') as f: f.write('x')
        print('see https://example.org/docs/x', open('/dev/null'))
        PY
        git diff --check
        """
        let shell = ToolPresentation(title: "exec_command", text: "{\"cmd\":\(String(decoding: try! JSONEncoder().encode(cmd), as: UTF8.self))}")
        XCTAssertTrue(shell.editsFiles)
        XCTAssertEqual(shell.editedPaths, ["/Users/me/.phren/objectstudio/reference/live-midi", "/dev/null"])
        XCTAssertTrue(ToolPresentation(title: "Bash", text: "{\"command\":\"sed -i '' 's/a/b/' ~/work/app/README.md\"}").editedPaths == ["~/work/app/README.md"])
        XCTAssertTrue(ToolPresentation(title: "Bash", text: "{\"command\":\"touch ./notes/today.md\"}").editsFiles)
        XCTAssertEqual(ToolPresentation(title: "Bash", text: "{\"command\":\"touch ./notes/today.md\"}").editedPaths, ["./notes/today.md"])
        // Reading is not writing.
        let read = ToolPresentation(title: "Bash", text: "{\"command\":\"cat /Users/me/.phren/phren/tasks.md | head\"}")
        XCTAssertFalse(read.editsFiles); XCTAssertEqual(read.editedPaths, [])
    }
}
