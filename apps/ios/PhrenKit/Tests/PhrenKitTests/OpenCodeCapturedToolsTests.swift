import XCTest
@testable import PhrenKit

final class OpenCodeCapturedToolsTests: XCTestCase {
    func testEveryCapturedToolRoutesToItsCard() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Phren/Resources/opencode-tools.jsonl"), encoding: .utf8)
        let expected: [String: AgentToolClassification] = ["todowrite": .todos, "edit": .patch, "write": .patch, "task": .agent,
            "read": .generic, "grep": .generic, "glob": .generic, "invalid": .generic, "bash": .generic,
            "webfetch": .web, "websearch": .web, "skill": .skill]
        let verbs = ["get_tasks": "Read tasks", "manage_task": "Update task", "add_task": "Add task", "add_finding": "Save finding",
                     "search_knowledge": "Search memory", "session": "Session", "get_project_summary": "Read project", "revise_finding": "Revise finding"]
        var seen = Set<String>()
        for line in source.split(separator: "\n") {
            let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            let name = try XCTUnwrap(value["tool"] as? String), input = try XCTUnwrap(value["input"] as? [String: Any])
            let text = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
            let kind = AgentToolClassification.kind(name: name, input: text)
            XCTAssertEqual(kind, name.hasPrefix("phren_") ? .phren : expected[name], name)
            if name.hasPrefix("phren_") {
                let bare = String(name.dropFirst(6))
                let presentation = try XCTUnwrap(PhrenToolPresentation(name: name, input: text))
                XCTAssertEqual(presentation.verb, bare == "phren_admin" ? input["action"] as? String : verbs[bare], name)
            }
            if kind == .todos { XCTAssertEqual(AgentTodoPresentation(name: name, input: text)?.items.count, (input["todos"] as? [Any])?.count) }
            if kind == .agent { XCTAssertEqual(AgentSubagentPresentation(name: name, input: text)?.prompt, input["prompt"] as? String) }
            seen.insert(name)
        }
        XCTAssertEqual(seen.count, 21)
    }
}
