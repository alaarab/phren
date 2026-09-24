import XCTest
@testable import PhrenKit

final class AgentToolCardsTests: XCTestCase {
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    func testSubagentReadsDescriptionModelAndReportAndStripsTrailers() throws {
        let input = try json(["description": "Audit the timeline", "prompt": "Read the models.\nReport what folds.", "subagent_type": "Explore", "model": "haiku"])
        let running = try XCTUnwrap(AgentSubagentPresentation(name: "Task", input: input))
        XCTAssertEqual(running.name, "Explore"); XCTAssertEqual(running.description, "Audit the timeline")
        XCTAssertEqual(running.model, "haiku"); XCTAssertEqual(running.state, .running)
        XCTAssertEqual(running.report, ""); XCTAssertFalse(running.background)
        let report = "# Findings\n- Reads fold\n- Writes keep their card\n\nagentId: abc123 (for resuming)\n<usage>total_tokens: 12</usage>"
        let done = try XCTUnwrap(AgentSubagentPresentation(name: "functions.Agent", input: input, result: report))
        XCTAssertEqual(done.state, .done)
        XCTAssertEqual(done.report, "# Findings\n- Reads fold\n- Writes keep their card")
        // A named agent shows its name over its type; a content list unwraps.
        let named = try XCTUnwrap(AgentSubagentPresentation(name: "Task", input: try json(["name": "tester", "subagent_type": "general-purpose", "prompt": "Run tests"]),
                                                             result: try json([["type": "text", "text": "All green"]])))
        XCTAssertEqual(named.name, "tester"); XCTAssertEqual(named.description, "Run tests"); XCTAssertEqual(named.report, "All green")
        XCTAssertEqual(AgentSubagentPresentation(name: "Task", input: "{}", result: "boom", isError: true)?.state, .failed)
        XCTAssertNil(AgentSubagentPresentation(name: "Read", input: "{}"))
        XCTAssertNotNil(AgentSubagentPresentation(name: "Task", input: "not json"))
    }

    func testBackgroundAgentStaysRunningUntilItsNotification() throws {
        let input = try json(["description": "Run the suite", "prompt": "swift test", "run_in_background": true])
        let launched = "Async agent launched successfully.\nagentId: a1 (for resuming)\noutput_file: /tmp/a1.txt"
        let running = try XCTUnwrap(AgentSubagentPresentation(name: "Task", input: input, result: launched))
        XCTAssertTrue(running.background); XCTAssertEqual(running.state, .running); XCTAssertEqual(running.report, "")
        let notice = "<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"tester\" completed</summary>\n</task-notification>"
        let done = try XCTUnwrap(AgentSubagentPresentation(name: "Task", input: input, result: launched, notification: notice))
        XCTAssertEqual(done.state, .done); XCTAssertEqual(done.summary, "Agent \"tester\" completed")
        let failed = notice.replacingOccurrences(of: "completed", with: "failed")
        XCTAssertEqual(AgentSubagentPresentation(name: "Task", input: input, result: launched, notification: failed)?.state, .failed)
    }

    func testCodexSpawnUsesReadableTaskNameAndHidesEncryptedInstructions() throws {
        let encrypted = "gAAAAA" + String(repeating: "opaque-token_", count: 12)
        let input = try json(["task_name": "/root/task_agent_launch", "message": encrypted])
        let result = try json(["task_name": "/root/task_agent_launch"])
        let agent = try XCTUnwrap(AgentSubagentPresentation(name: "collaboration.spawn_agent", input: input, result: result))
        XCTAssertEqual(agent.name, "Task Agent Launch")
        XCTAssertEqual(agent.description, "")
        XCTAssertEqual(agent.prompt, "")
        XCTAssertFalse(agent.promptAvailable)
        XCTAssertEqual(agent.report, "")
        XCTAssertEqual(agent.state, .running, "The spawn acknowledgement is not the child agent's final report")
        XCTAssertTrue(agent.background)
    }

    func testTodoWriteAndUpdatePlanBecomeChecklists() throws {
        let todos = try json(["todos": [
            ["content": "Add the card", "status": "completed", "activeForm": "Adding the card"],
            ["content": "Test it", "status": "in_progress", "activeForm": "Testing it"],
            ["content": "Ship", "status": "pending"]]])
        let list = try XCTUnwrap(AgentTodoPresentation(name: "TodoWrite", input: todos))
        XCTAssertEqual(list.title, "Todos"); XCTAssertTrue(list.isSnapshot)
        XCTAssertEqual(list.items.map(\.status), [.done, .active, .pending])
        XCTAssertEqual(list.items[1].activeForm, "Testing it")
        XCTAssertEqual(list.summary, "1 of 3 done")
        let plan = try XCTUnwrap(AgentTodoPresentation(name: "functions.update_plan", input: try json(["explanation": "Two steps", "plan": [["step": "Look", "status": "completed"], ["step": "Fix", "status": "pending"]]])))
        XCTAssertEqual(plan.title, "Plan"); XCTAssertEqual(plan.note, "Two steps")
        XCTAssertEqual(plan.items.map(\.text), ["Look", "Fix"]); XCTAssertEqual(plan.doneCount, 1)
        XCTAssertNil(AgentTodoPresentation(name: "TodoWrite", input: "{\"todos\":[]}"), "Nothing to list means no card")
        XCTAssertNil(AgentTodoPresentation(name: "Bash", input: "{}"))
    }

    func testTaskToolsAreSingleItemsAndTaskListReadsItsResult() throws {
        let created = try XCTUnwrap(AgentTodoPresentation(name: "TaskCreate", input: try json(["subject": "Verify the activity", "description": "On a device"])))
        XCTAssertEqual(created.title, "Tasks"); XCTAssertFalse(created.isSnapshot)
        XCTAssertEqual(created.items.map(\.text), ["Verify the activity"]); XCTAssertEqual(created.note, "On a device")
        let updated = try XCTUnwrap(AgentTodoPresentation(name: "TaskUpdate", input: try json(["taskId": "3", "status": "completed"])))
        XCTAssertEqual(updated.items.first?.text, "Task #3"); XCTAssertEqual(updated.items.first?.status, .done)
        let structured = try XCTUnwrap(AgentTodoPresentation(name: "TaskList", input: "{}", result: try json([["id": 1, "subject": "One", "status": "completed"], ["id": 2, "subject": "Two", "status": "in_progress"]])))
        XCTAssertTrue(structured.isSnapshot); XCTAssertEqual(structured.items.map(\.status), [.done, .active])
        let lines = try XCTUnwrap(AgentTodoPresentation(name: "TaskList", input: "{}", result: "- [x] One\n- [ ] Two\n- [~] Three"))
        XCTAssertEqual(lines.items.map(\.status), [.done, .pending, .active])
        let prose = try XCTUnwrap(AgentTodoPresentation(name: "TaskList", input: "{}", result: "No tasks yet."))
        XCTAssertTrue(prose.items.isEmpty); XCTAssertEqual(prose.note, "No tasks yet.")
    }

    func testLaterSnapshotsSupersedeEarlierOnesOfTheSameFamily() throws {
        let first = try XCTUnwrap(AgentTodoPresentation(name: "TodoWrite", input: try json(["todos": [["content": "A", "status": "pending"]]])))
        let second = try XCTUnwrap(AgentTodoPresentation(name: "TodoWrite", input: try json(["todos": [["content": "A", "status": "completed"]]])))
        let plan = try XCTUnwrap(AgentTodoPresentation(name: "update_plan", input: try json(["plan": [["step": "A", "status": "pending"]]])))
        let task = try XCTUnwrap(AgentTodoPresentation(name: "TaskCreate", input: try json(["subject": "B"])))
        XCTAssertEqual(AgentTodoPresentation.superseded([first, nil, plan, task, second]), [true, false, false, false, false])
        XCTAssertEqual(AgentTodoPresentation.superseded([task, task]), [false, false], "Single tasks are never replaced")
        XCTAssertEqual(AgentTodoPresentation.superseded([second, first]), [true, false])
    }

    func testPlanReadsMarkdownAndItsAnswer() throws {
        let input = try json(["plan": "# Plan\n\n1. Add the card\n2. Test it"])
        let pending = try XCTUnwrap(AgentPlanPresentation(name: "ExitPlanMode", input: input))
        XCTAssertEqual(pending.state, .pending); XCTAssertEqual(pending.plan, "# Plan\n\n1. Add the card\n2. Test it")
        XCTAssertEqual(AgentPlanPresentation(name: "ExitPlanMode", input: input, result: "User has approved your plan. You can now start coding.")?.state, .approved)
        XCTAssertEqual(AgentPlanPresentation(name: "ExitPlanMode", input: input, result: "The user doesn't want to proceed with this tool use.", isError: true)?.state, .rejected)
        XCTAssertNil(AgentPlanPresentation(name: "EnterPlanMode", input: "{}"))
        XCTAssertTrue(AgentPlanPresentation.isPlanMode("functions.EnterPlanMode"))
        let approval = try JSONDecoder().decode(AgentApproval.self, from: try JSONSerialization.data(withJSONObject: ["actionId": "a1", "toolName": "ExitPlanMode", "message": input]))
        XCTAssertTrue(approval.isPlan); XCTAssertEqual(approval.plan?.plan, pending.plan)
        XCTAssertEqual(approval.explanation, "# Plan\n\n1. Add the card\n2. Test it", "The Live Activity shows the plan, not its JSON")
        let other = try JSONDecoder().decode(AgentApproval.self, from: try JSONSerialization.data(withJSONObject: ["actionId": "a2", "toolName": "Bash", "message": "{\"command\":\"ls\"}"]))
        XCTAssertFalse(other.isPlan); XCTAssertNil(other.plan)
    }
}
