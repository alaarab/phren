import { describe, expect, it } from "vitest";
import {
  AgentSubagentPresentation, AgentTodoPresentation, AgentPlanPresentation, AgentApproval, approvalPlan, isPlanApproval,
  ToolCallText, WebToolPresentation, SkillCallPresentation, MCPToolPresentation,
} from "./tool-cards.js";
import type { JsonObject } from "./tool-presentation.js";

const S = AgentSubagentPresentation;
const T = AgentTodoPresentation;
const json = (value: unknown): string => JSON.stringify(value);

describe("AgentToolCardsTests", () => {
  it("subagentReadsDescriptionModelAndReportAndStripsTrailers", () => {
    const input = json({ description: "Audit the timeline", prompt: "Read the models.\nReport what folds.", subagent_type: "Explore", model: "haiku" });
    const running = S.of("Task", input)!;
    expect(running.name).toBe("Explore"); expect(running.description).toBe("Audit the timeline");
    expect(running.model).toBe("haiku"); expect(running.state).toBe(AgentSubagentPresentation.State.RUNNING);
    expect(running.report).toBe(""); expect(running.background).toBe(false);
    const report = "# Findings\n- Reads fold\n- Writes keep their card\n\nagentId: abc123 (for resuming)\n<usage>total_tokens: 12</usage>";
    const done = S.of("functions.Agent", input, report)!;
    expect(done.state).toBe(AgentSubagentPresentation.State.DONE);
    expect(done.report).toBe("# Findings\n- Reads fold\n- Writes keep their card");
    const named = S.of("Task", json({ name: "tester", subagent_type: "general-purpose", prompt: "Run tests" }), json([{ type: "text", text: "All green" }]))!;
    expect(named.name).toBe("tester"); expect(named.description).toBe("Run tests"); expect(named.report).toBe("All green");
    expect(S.of("Task", "{}", "boom", true)?.state).toBe(AgentSubagentPresentation.State.FAILED);
    expect(S.of("Read", "{}")).toBeNull();
    expect(S.of("Task", "not json")).not.toBeNull();
  });

  it("backgroundAgentStaysRunningUntilItsNotification", () => {
    const input = json({ description: "Run the suite", prompt: "swift test", run_in_background: true });
    const launched = "Async agent launched successfully.\nagentId: a1 (for resuming)\noutput_file: /tmp/a1.txt";
    const running = S.of("Task", input, launched)!;
    expect(running.background).toBe(true); expect(running.state).toBe(AgentSubagentPresentation.State.RUNNING); expect(running.report).toBe("");
    const notice = "<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"tester\" completed</summary>\n</task-notification>";
    const done = S.of("Task", input, launched, false, notice)!;
    expect(done.state).toBe(AgentSubagentPresentation.State.DONE); expect(done.summary).toBe("Agent \"tester\" completed");
    expect(S.of("Task", input, launched, false, notice.replace("completed", "failed"))?.state).toBe(AgentSubagentPresentation.State.FAILED);
  });

  it("codexSpawnUsesReadableTaskNameAndHidesEncryptedInstructions", () => {
    const encrypted = "gAAAAA" + "opaque-token_".repeat(12);
    const agent = S.of("collaboration.spawn_agent", json({ task_name: "/root/task_agent_launch", message: encrypted }), json({ task_name: "/root/task_agent_launch" }))!;
    expect(agent.name).toBe("Task Agent Launch"); expect(agent.description).toBe(""); expect(agent.prompt).toBe("");
    expect(agent.promptAvailable).toBe(false); expect(agent.report).toBe("");
    expect(agent.state).toBe(AgentSubagentPresentation.State.RUNNING);
    expect(agent.background).toBe(true);
  });

  it("todoWriteAndUpdatePlanBecomeChecklists", () => {
    const todos = json({ todos: [
      { content: "Add the card", status: "completed", activeForm: "Adding the card" },
      { content: "Test it", status: "in_progress", activeForm: "Testing it" },
      { content: "Ship", status: "pending" },
    ] });
    const list = T.of("TodoWrite", todos)!;
    expect(list.title).toBe("Todos"); expect(list.isSnapshot).toBe(true);
    const st = [AgentTodoPresentation.Item.Status.PENDING, AgentTodoPresentation.Item.Status.ACTIVE, AgentTodoPresentation.Item.Status.DONE];
    expect(list.items.map((i) => i.status)).toEqual([st[2], st[1], st[0]]);
    expect(list.items[1].activeForm).toBe("Testing it");
    expect(list.summary).toBe("1 of 3 done");
    const plan = T.of("functions.update_plan", json({ explanation: "Two steps", plan: [{ step: "Look", status: "completed" }, { step: "Fix", status: "pending" }] }))!;
    expect(plan.title).toBe("Plan"); expect(plan.note).toBe("Two steps");
    expect(plan.items.map((i) => i.text)).toEqual(["Look", "Fix"]); expect(plan.doneCount).toBe(1);
    expect(T.of("TodoWrite", "{\"todos\":[]}")).toBeNull();
    expect(T.of("Bash", "{}")).toBeNull();
  });

  it("taskToolsAreSingleItemsAndTaskListReadsItsResult", () => {
    const st = [AgentTodoPresentation.Item.Status.PENDING, AgentTodoPresentation.Item.Status.ACTIVE, AgentTodoPresentation.Item.Status.DONE];
    const created = T.of("TaskCreate", json({ subject: "Verify the activity", description: "On a device" }))!;
    expect(created.title).toBe("Tasks"); expect(created.isSnapshot).toBe(false);
    expect(created.items.map((i) => i.text)).toEqual(["Verify the activity"]); expect(created.note).toBe("On a device");
    const updated = T.of("TaskUpdate", json({ taskId: "3", status: "completed" }))!;
    expect(updated.items[0].text).toBe("Task #3"); expect(updated.items[0].status).toBe(AgentTodoPresentation.Item.Status.DONE);
    const structured = T.of("TaskList", "{}", json([{ id: 1, subject: "One", status: "completed" }, { id: 2, subject: "Two", status: "in_progress" }]))!;
    expect(structured.isSnapshot).toBe(true); expect(structured.items.map((i) => i.status)).toEqual([st[2], st[1]]);
    const lines = T.of("TaskList", "{}", "- [x] One\n- [ ] Two\n- [~] Three")!;
    expect(lines.items.map((i) => i.status)).toEqual([st[2], st[0], st[1]]);
    const prose = T.of("TaskList", "{}", "No tasks yet.")!;
    expect(prose.items.length).toBe(0); expect(prose.note).toBe("No tasks yet.");
  });

  it("laterSnapshotsSupersedeEarlierOnesOfTheSameFamily", () => {
    const first = T.of("TodoWrite", json({ todos: [{ content: "A", status: "pending" }] }))!;
    const second = T.of("TodoWrite", json({ todos: [{ content: "A", status: "completed" }] }))!;
    const plan = T.of("update_plan", json({ plan: [{ step: "A", status: "pending" }] }))!;
    const task = T.of("TaskCreate", json({ subject: "B" }))!;
    expect(AgentTodoPresentation.superseded([first, null, plan, task, second])).toEqual([true, false, false, false, false]);
    expect(AgentTodoPresentation.superseded([task, task])).toEqual([false, false]);
    expect(AgentTodoPresentation.superseded([second, first])).toEqual([true, false]);
  });

  it("planReadsMarkdownAndItsAnswer", () => {
    const input = json({ plan: "# Plan\n\n1. Add the card\n2. Test it" });
    const pending = AgentPlanPresentation.of("ExitPlanMode", input)!;
    expect(pending.state).toBe(AgentPlanPresentation.State.PENDING); expect(pending.plan).toBe("# Plan\n\n1. Add the card\n2. Test it");
    expect(AgentPlanPresentation.of("ExitPlanMode", input, "User has approved your plan. You can now start coding.")?.state).toBe(AgentPlanPresentation.State.APPROVED);
    expect(AgentPlanPresentation.of("ExitPlanMode", input, "The user doesn't want to proceed with this tool use.", true)?.state).toBe(AgentPlanPresentation.State.REJECTED);
    expect(AgentPlanPresentation.of("EnterPlanMode", "{}")).toBeNull();
    expect(AgentPlanPresentation.isPlanMode("functions.EnterPlanMode")).toBe(true);
    const approval = AgentApproval.read(JSON.parse(json({ actionId: "a1", toolName: "ExitPlanMode", message: input })) as JsonObject);
    expect(isPlanApproval(approval)).toBe(true); expect(approvalPlan(approval)?.plan).toBe(pending.plan);
    expect(approval.explanation).toBe("# Plan\n\n1. Add the card\n2. Test it");
    const other = AgentApproval.read(JSON.parse(json({ actionId: "a2", toolName: "Bash", message: "{\"command\":\"ls\"}" })) as JsonObject);
    expect(isPlanApproval(other)).toBe(false); expect(approvalPlan(other)).toBeNull();
  });
});

describe("ToolCardPresentationTests", () => {
  it("fetchShowsHostAndPathAndKeepsPromptAndResultPreview", () => {
    const body = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of the page.`).join("\n");
    const fetch = WebToolPresentation.of("WebFetch",
      json({ url: "https://developer.apple.com/documentation/swiftui/scrollview/?language=swift#overview", prompt: "Summarize nested scrolling" }), body)!;
    expect(fetch.kind).toBe(WebToolPresentation.Kind.FETCH); expect(fetch.title).toBe("Fetch");
    expect(fetch.location).toBe("developer.apple.com/documentation/swiftui/scrollview");
    expect(fetch.url).toBe("https://developer.apple.com/documentation/swiftui/scrollview/?language=swift#overview");
    expect(fetch.prompt).toBe("Summarize nested scrolling");
    expect(fetch.status).toBe(WebToolPresentation.Status.SUCCEEDED);
    expect(fetch.resultMarkdown?.split("\n").length).toBe(WebToolPresentation.PREVIEW_LINES);
    expect(fetch.resultTruncated).toBe(true);
    expect(fetch.result).toBe(body);
    const running = WebToolPresentation.of("functions.WebFetch", json({ url: "https://example.org/a/b/" }))!;
    expect(running.status).toBe(WebToolPresentation.Status.RUNNING); expect(running.resultMarkdown).toBeNull(); expect(running.prompt).toBeNull();
    expect(running.location).toBe("example.org/a/b");
    expect(WebToolPresentation.of("WebFetch", json({ url: "https://example.org" }), "Blocked", true)?.status).toBe(WebToolPresentation.Status.FAILED);
  });

  it("searchQuotesTheQueryAndTurnsClaudeCodeLinksIntoMarkdownLinks", () => {
    const links = json([
      { title: "ScrollView | Apple Developer", url: "https://developer.apple.com/documentation/swiftui/scrollview" },
      { title: "Nested [scrolling]", url: "https://example.org/nested" },
      { url: "https://example.org/untitled" },
    ]);
    const result = "Web search results for query: \"SwiftUI nested scrolling\"\n\nLinks: " + links + "\n\nSwiftUI's ScrollView hands nested scrolling to the inner view.";
    const search = WebToolPresentation.of("WebSearch", json({ query: "SwiftUI nested scrolling" }), result)!;
    expect(search.kind).toBe(WebToolPresentation.Kind.SEARCH); expect(search.title).toBe("Search");
    expect(search.location).toBe("“SwiftUI nested scrolling”"); expect(search.query).toBe("SwiftUI nested scrolling");
    expect(search.url).toBeNull(); expect(search.prompt).toBeNull();
    const markdown = search.resultMarkdown!;
    expect(markdown.includes("• [ScrollView | Apple Developer](https://developer.apple.com/documentation/swiftui/scrollview)")).toBe(true);
    expect(markdown.includes("• [Nested \\[scrolling\\]](https://example.org/nested)")).toBe(true);
    expect(markdown.includes("• [https://example.org/untitled](https://example.org/untitled)")).toBe(true);
    expect(markdown.includes("Links: [")).toBe(false);
    expect(search.resultTruncated).toBe(false);
    expect(search.result).toBe(result);
  });

  it("webToolRecognitionAndMalformedInput", () => {
    for (const name of ["WebFetch", "web_fetch", "functions.WebSearch", "web_search"]) expect(WebToolPresentation.recognizes(name)).toBe(true);
    for (const name of ["Read", "mcp__web__search", "Skill", null]) expect(WebToolPresentation.recognizes(name)).toBe(false);
    expect(WebToolPresentation.of("Read", "{}")).toBeNull();
    const broken = WebToolPresentation.of("WebFetch", "not json")!;
    expect(broken.location).toBe("not json"); expect(broken.url).toBeNull();
    const wrapped = json({ content: [{ type: "text", text: "# Page\n\nBody" }] });
    expect(WebToolPresentation.of("WebFetch", json({ url: "https://x.y/z" }), wrapped)?.resultMarkdown).toBe("# Page\n\nBody");
  });

  it("skillChipReadsTheCommandArgsAndHidesTheBody", () => {
    const skill = SkillCallPresentation.of("Skill", json({ skill: "design", args: "the chat cards\nsecond line" }), "Launching skill: design\n\n# Design pass\n…")!;
    expect(skill.command).toBe("/design");
    expect(skill.args).toBe("the chat cards");
    expect(skill.status).toBe(SkillCallPresentation.Status.SUCCEEDED);
    expect(skill.result).toBe("Launching skill: design\n\n# Design pass\n…");
    const bare = SkillCallPresentation.of("functions.Skill", json({ skill: "/phren-learn" }))!;
    expect(bare.command).toBe("/phren-learn"); expect(bare.args).toBeNull(); expect(bare.status).toBe(SkillCallPresentation.Status.RUNNING);
    const long = SkillCallPresentation.of("use_skill", json({ name: "video", arguments: "x".repeat(300) }))!;
    expect(long.args?.length).toBe(121); expect(long.args?.endsWith("…")).toBe(true);
    expect(SkillCallPresentation.of("Skill", json({ skill: "design" }), "No such skill", true)?.status).toBe(SkillCallPresentation.Status.FAILED);
  });

  it("skillChipNeverInventsACommand", () => {
    expect(SkillCallPresentation.of("Skill", "{}")).toBeNull();
    expect(SkillCallPresentation.of("Skill", "broken")).toBeNull();
    expect(SkillCallPresentation.of("Skill", json({ skill: "two\nlines" }))).toBeNull();
    expect(SkillCallPresentation.of("Read", json({ skill: "design" }))).toBeNull();
    expect(SkillCallPresentation.recognizes("functions.Skill")).toBe(true); expect(SkillCallPresentation.recognizes("mcp__x__skill")).toBe(false);
  });

  it("mcpCardHumanizesServerAndToolAndRowsTheInput", () => {
    const input = json({ owner: "alaarab", repo: "phren", pull_number: 42, draft: false,
      filters: { state: "open", sort: "updated" }, labels: ["ios", "chat"], note: null });
    const card = MCPToolPresentation.of("mcp__github__get_pull_request", input)!;
    expect(card.server).toBe("GitHub"); expect(card.verb).toBe("Get pull request");
    expect(card.status).toBe(MCPToolPresentation.Status.RUNNING); expect(card.resultLines).toEqual([]);
    const rows: Record<string, string> = {};
    for (const f of card.fields) rows[f.name] = f.value;
    expect(rows["owner"]).toBe("alaarab"); expect(rows["pull number"]).toBe("42"); expect(rows["draft"]).toBe("false");
    expect(rows["filters"]).toBe("{2 fields}"); expect(rows["labels"]).toBe("2 items"); expect(rows["note"]).toBe("—");
    expect(card.hiddenFields).toBe(0);
    expect(card.fields.some((f) => f.value.includes("{\""))).toBe(false);
    expect(MCPToolPresentation.of("functions.mcp__herdr__listPanes", "{}")?.server).toBe("Herdr");
    expect(MCPToolPresentation.of("mcp__herdr__listPanes", "{}")?.verb).toBe("List panes");
    expect(MCPToolPresentation.of("mcp__claude_ai_Gmail__search-mail", "{}")?.server).toBe("Claude Ai Gmail");
    expect(MCPToolPresentation.of("mcp__claude_ai_Gmail__search-mail", "{}")?.verb).toBe("Search mail");
    expect(MCPToolPresentation.of("mcp__acme__get_PR_info", "{}")?.verb).toBe("Get PR info");
    const wide = MCPToolPresentation.of("mcp__acme__tool", json(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, "v"]))))!;
    expect(wide.fields.length).toBe(MCPToolPresentation.MAXIMUM_FIELDS); expect(wide.hiddenFields).toBe(4);
    expect(MCPToolPresentation.of("mcp__acme__tool", "broken")).not.toBeNull();
  });

  it("mcpResultObjectsReadAsKeyLinesWithoutTopLevelBraces", () => {
    const payload = json({ number: 42, title: "Chat: cards for web, skills and MCP", state: "open",
      user: { login: "alaarab", id: 7 }, labels: [{ name: "ios" }, { name: "chat" }], zzz: "last", aaa: "first" });
    const envelope = json({ content: [{ type: "text", text: payload }] });
    const card = MCPToolPresentation.of("mcp__github__get_pull_request", "{}", envelope)!;
    expect(card.status).toBe(MCPToolPresentation.Status.SUCCEEDED);
    expect(card.resultLines.slice(0, 3)).toEqual(["title: Chat: cards for web, skills and MCP", "state: open", "number: 42"]);
    expect(card.resultLines.includes("user: id: 7 · login: alaarab")).toBe(true);
    expect(card.resultLines.includes("labels: 2 items")).toBe(true);
    expect(card.resultLines.length).toBe(MCPToolPresentation.MAXIMUM_RESULT_LINES);
    expect(card.resultTruncated).toBe(true);
    expect(card.resultLines.some((l) => l.startsWith("{") || l.includes("{\""))).toBe(false);
    const text = MCPToolPresentation.of("mcp__herdr__list_panes", "{}", "3 panes\n1 codex\n2 claude")!;
    expect(text.resultLines).toEqual(["3 panes", "1 codex", "2 claude"]); expect(text.resultTruncated).toBe(false);
    const list = MCPToolPresentation.of("mcp__herdr__list_panes", "{}", json([{ title: "One" }, { title: "Two" }]))!;
    expect(list.resultLines).toEqual(["2 items", "· title: One", "· title: Two"]);
    const structured = json({ content: [{ type: "text", text: "ignored" }], structuredContent: { count: 3 } });
    expect(MCPToolPresentation.of("mcp__acme__count", "{}", structured)?.resultLines).toEqual(["count: 3"]);
  });

  it("mcpFailuresAndRecognition", () => {
    const flagged = MCPToolPresentation.of("mcp__github__merge_pull_request", "{}", "Pull request is not mergeable", true)!;
    expect(flagged.status).toBe(MCPToolPresentation.Status.FAILED); expect(flagged.resultLines).toEqual(["Pull request is not mergeable"]);
    const envelope = json({ isError: true, content: [{ type: "text", text: "Rate limited" }] });
    const mcpError = MCPToolPresentation.of("mcp__github__merge_pull_request", "{}", envelope)!;
    expect(mcpError.status).toBe(MCPToolPresentation.Status.FAILED); expect(mcpError.resultLines).toEqual(["Rate limited"]);
    for (const name of ["mcp__github__get_pull_request", "functions.mcp__herdr__list_panes", "mcp__a__b__c"]) expect(MCPToolPresentation.recognizes(name)).toBe(true);
    for (const name of ["mcp__phren__add_task", "functions.mcp__phren__session", "mcp__github", "mcp____tool", "Read", "WebFetch", null]) expect(MCPToolPresentation.recognizes(name)).toBe(false);
    expect(MCPToolPresentation.of("mcp__phren__add_task", "{}")).toBeNull();
  });

  it("sentenceCaseAndPlainValues", () => {
    expect(ToolCallText.sentence("get_pull_request")).toBe("Get pull request");
    expect(ToolCallText.sentence("listIssueComments")).toBe("List issue comments");
    expect(ToolCallText.sentence("search-code")).toBe("Search code");
    expect(ToolCallText.sentence("read_URL")).toBe("Read URL");
    expect(ToolCallText.plain({ a: 1 })).toBe("{1 field}");
    expect(ToolCallText.plain([1, 2, 3])).toBe("3 items");
    expect(ToolCallText.plain("x".repeat(300)).length).toBe(201);
    expect(ToolCallText.plain(true)).toBe("true");
    expect(ToolCallText.plain(1)).toBe("1");
  });
});
