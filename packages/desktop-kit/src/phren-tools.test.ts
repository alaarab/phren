import { describe, expect, it } from "vitest";
import { PhrenToolPresentation } from "./phren-tools.js";

const P = PhrenToolPresentation;
const json = (value: unknown): string => JSON.stringify(value);

describe("PhrenToolPresentationTests", () => {
  it("findingTaskAndSessionVerbsUseHumanInput", () => {
    const finding = P.of("mcp__phren__add_finding", `{"project":"phone","finding":"Keep the real image turn","findingType":"pitfall"}`, `{"ok":true}`)!;
    expect(finding.verb).toBe("Save finding"); expect(finding.body).toBe("Keep the real image turn");
    expect(finding.project).toBe("phone"); expect(finding.tag).toBe("pitfall");
    expect(finding.status).toBe(P.Status.SUCCEEDED);
    const task = P.of("functions.mcp__phren__add_task", `{"task":"Verify the queue"}`)!;
    expect(task.verb).toBe("Add task"); expect(task.body).toBe("Verify the queue");
    expect(task.status).toBe(P.Status.RUNNING);
    const done = P.of("mcp__phren__manage_task", `{"action":"complete","item":"A2"}`)!;
    expect(done.verb).toBe("Update task"); expect(done.body).toBe("A2");
    expect(done.fields[0].value).toBe("complete");
    for (const [tool, input, verb] of [["session", `{"action":"start"}`, "Session"], ["session", `{"action":"end"}`, "Session"], ["phren_admin", `{"action":"status"}`, "Status"]] as const) {
      expect(P.of(`mcp__phren__${tool}`, input)?.verb).toBe(verb);
    }
  });

  it("searchUnwrapsActualMCPEnvelopeAndBoundsTitles", () => {
    const response = `{"ok":true,"data":{"count":7,"results":[{"title":"First"},{"snippet":"Second\\nMore text"},{"filename":"Third.md"},{"title":"Hidden fourth"}]}}`;
    const wrapped = json({ content: [{ type: "text", text: response }] });
    const search = P.of("mcp__phren__search_knowledge", `{"query":"queue"}`, wrapped)!;
    expect(search.verb).toBe("Search memory"); expect(search.body).toBe("queue");
    expect(search.resultSummary).toBe("7 memories found");
    expect(search.titles).toEqual(["First", "Second", "Third.md"]);
    expect(P.of("mcp__phren__search_knowledge", "{}", `{"ok":true,"data":{"results":[]}}`)?.resultSummary).toBe("0 memories found");
  });

  it("memoryDetailFailureAndFutureToolsRemainReadable", () => {
    const detail = P.of("mcp__phren__get_memory_detail", `{"id":"mem:42"}`, `{"ok":true,"data":{"content":"A memory title\\nIts body"}}`);
    expect(detail?.body).toBe("mem:42"); expect(detail?.resultSummary).toBe("A memory title");
    const failure = P.of("mcp__phren__add_task", "{}", `{"ok":false,"error":"Store is read-only"}`);
    expect(failure?.status).toBe(P.Status.FAILED); expect(failure?.resultSummary).toBe("Store is read-only");
    expect(P.of("mcp__phren__add_task", "{}", "Denied", true)?.status).toBe(P.Status.FAILED);
    const future = P.of("mcp__phren__future_tool", `{"project":"phone","scope":{"type":"team"},"values":["one","two"]}`)!;
    expect(future.fields.map((f) => f.value)).toEqual(["type: team", "one, two"]);
    expect(future.fields.some((f) => f.value.includes("{"))).toBe(false);
    expect(P.of("mcp__phren__future_tool", "broken JSON")).not.toBeNull();
    expect(P.of("mcp__other__add_task", "{}")).toBeNull();
  });

  it("longFindingPreviewIsBoundedWithoutModifyingInput", () => {
    const text = "Long finding. ".repeat(1_000);
    expect(P.of("mcp__phren__add_finding", json({ finding: text }))?.body).toBe(text.slice(0, 1200).trim());
  });

  it("readableUnwrapsContentBlocksAndPrettyPrintsPhrenResults", () => {
    const inner = `{"ok":true,"data":{"count":1,"results":[{"title":"Interactive back"}]},"message":"Found 1 result(s)."}`;
    const raw = `{"content":[{"type":"text","text":"${inner.replace(/"/g, "\\\"")}"}]}`;
    const readable = P.readable(raw);
    expect(readable).toBe("Found 1 result(s).");
    expect(readable.includes("\\\"")).toBe(false);
    expect(P.readable("plain prose, not JSON")).toBe("plain prose, not JSON");
    expect(P.readable(`{"content":[{"type":"text","text":"just text"}]}`)).toBe("just text");
  });

  it("nestedAndTransportFailuresKeepTheirReasonAndRawText", () => {
    const results = [
      `{"isError":true,"content":[{"type":"text","text":"Store is read-only.\\nNo task saved."}]}`,
      `{"structuredContent":{"ok":false,"error":{"message":"Store is read-only."}}}`,
      `{"content":[{"type":"text","text":"Processing"},{"type":"text","text":"{\\"ok\\":false,\\"error\\":\\"Store is read-only.\\"}"}]}`,
      `{"ok":true,"data":{"added":["First task"],"errors":["Store is read-only."]}}`,
    ];
    for (const result of results) {
      const card = P.of("mcp__phren__add_task", "{}", result)!;
      expect(card.status).toBe(P.Status.FAILED);
      expect(card.resultSummary).toBe("Store is read-only.");
      expect(card.rawResult).toBe(result);
      expect(card.target).toBeNull();
    }
    expect(P.of("phren_session", "{}", "Connection closed.\nTry later.", true)?.resultSummary).toBe("Connection closed.");
    expect(P.of("phren_session", "{}", null, true)?.status).toBe(P.Status.FAILED);
    expect(P.of("phren_session", "{}", "", true)?.resultSummary).toBe("Call failed");
    expect(P.of("phren_search_knowledge", "{}", `{"ok":true,"data":{"results":[{"error":"A finding about errors"}]}}`)?.status).toBe(P.Status.SUCCEEDED);
  });

  it("expandedInputAndEveryResultRemainComplete", () => {
    const long = "Keep this entire instruction.\n".repeat(100) + "Final marker";
    const task = P.of("phren_add_task", json({ item: long }))!;
    expect(task.fullInput.includes(long)).toBe(true);
    expect(task.body.length < long.length).toBe(true);
    expect(P.readable(`{"content":[{"type":"text","text":"First"},{"type":"text","text":"Last"}]}`)).toBe("First\n\nLast");
    const search = P.of("phren_search_knowledge", "{}", `{"ok":true,"data":{"results":[{"title":"First"},{"title":"Second"},{"title":"Third"},{"title":"Fourth","content":"Full recalled text"}]}}`)!;
    expect(search.titles.length).toBe(3);
    expect(search.searchResults.length).toBe(4);
    expect(search.searchResults[search.searchResults.length - 1].text).toBe("Full recalled text");
    expect(P.of("phren_manage_task", `{"action":"remove","item":"Old task"}`, `{"ok":true}`)?.target).toBeNull();
  });

  it("failedCallShowsItsIssuesNotItsParameterList", () => {
    const result = `{"ok":false,"error":"Invalid arguments for update_task","issues":[{"path":"updates","message":"Invalid input: expected object, received string"}],"params":[{"name":"project","required":true}]}`;
    const card = P.of("mcp__phren__manage_task", `{"action":"update","item":"bid:1"}`, result);
    expect(card?.status).toBe(P.Status.FAILED);
    expect(card?.resultSummary).toBe("Invalid arguments for update_task");
    expect(card?.issues).toEqual(["updates: Invalid input: expected object, received string"]);
  });
});

describe("PhrenToolItemsTests", () => {
  it("severalTasksInOneCallAreSeparateRows", () => {
    const card = P.of("mcp__phren__add_task", `{"project":"phren","item":["Search memory card misaligned","Show what the hook injected","Dispatch to the local Mac"]}`, `{"ok":true}`)!;
    expect(card.items).toEqual(["Search memory card misaligned", "Show what the hook injected", "Dispatch to the local Mac"]);
    expect(card.toolName).toBe("mcp__phren__add_task");
    expect(card.fullInput.includes("Dispatch to the local Mac")).toBe(true);
  });

  it("oneTaskStaysTheBody", () => {
    const card = P.of("mcp__phren__add_task", `{"project":"phren","item":["Just one"]}`)!;
    expect(card.items).toEqual([]);
    expect(card.body).toBe("Just one");
  });
});

describe("PhrenConductorToolTests", () => {
  const envelope = (data: Record<string, unknown>, ok = true, message: string | null = null): string =>
    json({ ok, data, ...(message !== null ? { message } : {}) });

  it("liveSessionsGroupByComputerWithStatusAndTheComputersItCouldNotSee", () => {
    const target = { server: "default", workspace: "w13", tab: "w13:t2", pane: "w13:p2", source: "claude", session: "s1" };
    const result = envelope({
      sessions: [
        { computer: "Mini", project: "phren", label: "phren", title: "Claude sesh", status: "idle", idleFor: 1768, target },
        { computer: "Mini", project: "ObjectStudio", label: "objectstudio", title: "MCP livemcp", status: "working" },
        { computer: "Omarchy", project: "hub", label: "hub", title: "Get on main", status: "blocked" },
        { computer: "Mini", label: "Conductor", title: "Job and purpose", status: "done", role: "conductor" },
      ],
      unreachable: [{ computer: "Linuxbox", error: "timed out" }],
      notLinked: [{ name: "MacBookPro", aliases: ["Alas-MacBook-Pro.local"] }],
    }, true, "4 live sessions across 2 computers.");
    const card = P.of("mcp__phren__phren_admin", `{"action":"live_sessions"}`, result)!;
    expect(card.verb).toBe("Live sessions");
    expect(card.resultSummary).toBe("4 sessions on 2 computers");
    const sessions = card.conductor as PhrenToolPresentation.Conductor.Sessions;
    expect(sessions.groups.map((g) => g.computer)).toEqual(["Mini", "Omarchy"]);
    expect(sessions.groups[0].rows.map((r) => r.status)).toEqual(["idle", "working", "done"]);
    expect(sessions.groups[0].rows[0].idleFor).toBe(1768);
    expect(sessions.groups[0].rows[2].conductor).toBe(true);
    expect(sessions.groups[1].rows[0].status).toBe("needs-you");
    expect(sessions.missing).toEqual(["Linuxbox (unreachable)", "MacBookPro"]);
    expect(P.of("mcp__phren__live_sessions", "{}", result)?.conductor).not.toBeNull();
  });

  it("dispatchReturnsShowEachWorkersOutcomeAndLiveSessionsNameOfflinePeers", () => {
    const returns = envelope({ returns: [
      { computer: "Mini", project: "phren", state: "done", reply: "\n**Shipped** the fix.\nSecond line." },
      { computer: "Linuxbox", state: "needs-you", question: "Should I push?" },
      { computer: "Studio", label: "tests", state: "failed", error: "Usage limit reached" },
      { computer: "Mini", state: "expired" },
    ] });
    const card = P.of("mcp__phren__phren_admin", `{"action":"dispatch_returns"}`, returns)!;
    expect(card.verb).toBe("Dispatch returns");
    expect(card.resultSummary).toBe("4 returns");
    const rows = (card.conductor as PhrenToolPresentation.Conductor.Returns).rows;
    expect(rows.map((r) => r.state)).toEqual(["done", "needs-you", "failed", "gone"]);
    expect(rows.map((r) => r.excerpt)).toEqual(["Shipped the fix.", "Should I push?", "Usage limit reached", null]);
    expect(rows[2].label).toBe("tests");
    expect(P.of("mcp__phren__dispatch_returns", "{}", envelope({ returns: [] }))?.resultSummary).toBe("No unread returns");

    const sessions = envelope({ sessions: [], unreachable: [
      { computer: "Linuxbox", code: "peer-offline" },
      { computer: "Studio", code: "future-code" },
    ] });
    const missing = (P.of("mcp__phren__live_sessions", "{}", sessions)?.conductor as PhrenToolPresentation.Conductor.Sessions).missing;
    expect(missing).toEqual(["Linuxbox (peer offline)", "Studio (unreachable)"]);
  });

  it("handOffNamesTheTargetAndKeepsThePromptAsTheBody", () => {
    const target = `{\\"server\\":\\"default\\",\\"workspace\\":\\"w1P\\",\\"tab\\":\\"w1P:t2\\",\\"pane\\":\\"w1P:p2\\",\\"source\\":\\"claude\\",\\"session\\":\\"804efd90\\"}`;
    const input = `{"action":"hand_off","target":"${target}","text":"From the conductor: you're paired with ObjectStudio.\\nSecond line."}`;
    const delivered = envelope({ ok: true, delivered: true, label: "objectstudio", target: { pane: "w1P:p2", session: "804efd90" } }, true, "Prompt delivered to the existing session.");
    const card = P.of("mcp__phren__phren_admin", input, delivered)!;
    expect(card.verb).toBe("Hand off");
    expect(card.conductor).toEqual(PhrenToolPresentation.Conductor.handOff("objectstudio (w1P:p2)"));
    expect(card.body).toBe("From the conductor: you're paired with ObjectStudio.\nSecond line.");
    expect(card.resultSummary).toBe("Delivered");
    expect(card.status).toBe(P.Status.SUCCEEDED);
    const unlabeled = P.of("mcp__phren__phren_admin", input, envelope({ ok: true, delivered: true }))!;
    expect(unlabeled.conductor).toEqual(PhrenToolPresentation.Conductor.handOff("w1P:p2"));
    const failed = P.of("mcp__phren__phren_admin", input, `{"ok":false,"error":"No live session with that id appears in the workspace overview."}`)!;
    expect(failed.status).toBe(P.Status.FAILED);
    expect(failed.resultSummary).toBe("No live session with that id appears in the workspace overview.");
  });

  it("dispatchShowsWhereItWentTheReceiptAndAFailuresReason", () => {
    const input = `{"action":"dispatch","computer":"Mac.attlocal.net","project":"phren","harness":"claude","model":"opus","label":"voice","prompt":"Long brief"}`;
    const accepted = P.of("mcp__phren__phren_admin", input,
      envelope({ ok: true, id: "f5a03ce0-6b9d-49be-a4ca-7227d7943d0b", state: "accepted", computer: "Mac.attlocal.net" }))!;
    expect(accepted.verb).toBe("Dispatch");
    expect(accepted.project).toBe("phren");
    expect(accepted.fields.map((f) => f.name)).toEqual(["Computer", "Harness", "Model", "Label"]);
    expect(accepted.fields.map((f) => f.value)).toEqual(["Mac.attlocal.net", "claude", "opus", "voice"]);
    expect(accepted.resultSummary).toBe("Accepted · receipt f5a03ce0");
    const refused = P.of("mcp__phren__phren_admin", input, `{"ok":false,"error":"Unknown computer. Add its verified connection to hooks.yaml."}`)!;
    expect(refused.status).toBe(P.Status.FAILED);
    expect(refused.resultSummary).toBe("Unknown computer. Add its verified connection to hooks.yaml.");
  });
});

describe("PhrenReadToolTests", () => {
  const text = (payload: string): string => json({ content: [{ type: "text", text: payload }] });
  const row = (title: string, detail: string | null = null, trailing: string | null = null): PhrenToolPresentation.Row => ({ title, detail, trailing });

  it("accountUsageDrawsABarPerWindowAndNamesWhatItCouldNotRead", () => {
    const result = text(`
    {"ok":true,"message":"2 accounts across 2 computers.","data":{"accounts":[
      {"id":"claude|k","harness":"claude","name":"Claude","account":"me@example.com","windows":[
        {"id":"five_hour","name":"5-hour limit","usedPercent":42.4,"leftPercent":58,"resetsIn":"2h 10m"},
        {"id":"seven_day","name":"7-day, all models","usedPercent":100,"leftPercent":0,"resetsIn":"3d 2h","exhausted":true},
        {"id":"seven_day_opus","name":"7-day, Opus","reset":true}],
       "exhausted":true,"availableIn":"3d 2h","stale":false,"age":"4m","nearLimit":true,"computers":[]},
      {"id":"opencode","harness":"opencode","name":"OpenCode","windows":[],"spend":{"amountUSD":12.345,"period":"rolling_7_days"},
       "exhausted":false,"stale":true,"age":"40m","nearLimit":false,"computers":[]}],
      "noData":[{"harness":"openrouter","name":"OpenRouter","computers":["desk"]}],
      "computers":["desk"],"unreachable":[{"computer":"mini","error":"x"}],"notLinked":[{"name":"macbook"}],"enrolled":2}}
    `);
    const card = P.of("mcp__phren__phren_admin", `{"action":"account_usage"}`, result)!;
    expect(card.verb).toBe("Account usage");
    expect(card.resultSummary).toBe("2 accounts, 1 out of quota");
    expect(card.fields).toEqual([]);
    expect(card.showsOutput).toBe(false);
    const usage = card.detail as PhrenToolPresentation.Detail.Usage;
    expect(usage.accounts.map((a) => a.name)).toEqual(["Claude", "OpenCode"]);
    expect(usage.accounts[0].account).toBe("me@example.com");
    expect(usage.accounts[0].windows.map((w) => w.usedPercent)).toEqual([42, 100, null]);
    expect(usage.accounts[0].windows.map((w) => w.exhausted)).toEqual([false, true, false]);
    expect(usage.accounts[0].windows[2].reset).toBe(true);
    expect(usage.accounts[0].availableIn).toBe("3d 2h");
    expect(usage.accounts[1].spend).toBe("$12.35 · 7 days");
    expect(usage.accounts[1].stale).toBe(true);
    expect(usage.missing).toEqual(["OpenRouter (no numbers)", "mini (unreachable)", "macbook"]);
    expect(card.detail).toEqual(P.of("mcp__phren__account_usage", "{}", result)?.detail);
  });

  it("listActionsShowsEachActionWithItsFirstSentenceAndRequiredParams", () => {
    const result = text(`{"ok":true,"actions":[{"name":"add_project","description":"Bootstrap a project into phren. Reads the repo.","params":[{"name":"path","required":true,"description":""},{"name":"profile","required":false,"description":""}]},{"name":"health_check","description":"Report health.","params":[]}]}`);
    const card = P.of("mcp__phren__phren_admin", `{"action":"list_actions"}`, result)!;
    expect(card.verb).toBe("Phren actions");
    expect(card.resultSummary).toBe("2 actions");
    expect(card.detail).toEqual(PhrenToolPresentation.Detail.rows([{ header: null, rows: [
      row("add_project", "Bootstrap a project into phren.", "path"), row("health_check", "Report health."),
    ] }]));
  });

  it("getTasksGroupsBySectionAndProject", () => {
    const one = text(`{"ok":true,"message":"## p","data":{"project":"p","items":{"Active":[{"id":"A1","stableId":"ab12cd34","section":"Active","line":"Fix login [high] [pinned]","checked":false,"priority":"high","pinned":true,"claim":{"computer":"desk","at":"x"}}],"Queue":[{"id":"Q1","section":"Queue","line":"Write docs","checked":false}],"Done":[]},"totalItems":2}}`);
    const card = P.of("mcp__phren__get_tasks", `{"project":"p"}`, one)!;
    expect(card.resultSummary).toBe("2 tasks");
    expect(card.detail).toEqual(PhrenToolPresentation.Detail.rows([
      { header: "Active", rows: [row("Fix login", "high · pinned · claimed on desk", "A1")] },
      { header: "Queue", rows: [row("Write docs", null, "Q1")] },
    ]));
    const all = text(`{"ok":true,"data":{"projects":[{"project":"a","items":{"Active":[],"Queue":[{"id":"Q1","line":"First"}],"Done":[]}},{"project":"b","items":{"Active":[{"id":"A1","line":"Second"}],"Queue":[],"Done":[]}}],"summary":false}}`);
    const groups = (P.of("mcp__phren__get_tasks", "{}", all)?.detail as PhrenToolPresentation.Detail.Rows).groups;
    expect(groups.map((g) => g.header)).toEqual(["a · Queue", "b · Active"]);
    const lookup = text(`{"ok":true,"message":"Q3: Fix it (Queue)","data":{"project":"p","id":"Q3","stableId":null,"section":"Queue","checked":false,"line":"Fix it","priority":null}}`);
    expect(P.of("mcp__phren__get_tasks", `{"project":"p","id":"Q3"}`, lookup)?.detail).toEqual(PhrenToolPresentation.Detail.rows([{ header: "Queue", rows: [row("Fix it", null, "Q3")] }]));
    const summary = text(`{"ok":true,"message":"**Active**: 3 items (1 high)\\n  - bid:1 Fix","data":{"project":"p","summary":true,"totalItems":3}}`);
    const folded = P.of("mcp__phren__get_tasks", `{"project":"p","summary":true}`, summary)!;
    expect(folded.detail).toBeNull();
    expect(folded.resultSummary).toBe("Active: 3 items (1 high)");
  });

  it("otherReadsDrawRows", () => {
    const inbox = text(`{"ok":true,"message":"1 owner inbox items.","data":{"ok":true,"items":[{"id":"1","kind":"needs-you","title":"Approve the merge","state":"open","project":"phren","computer":"desk"}],"unreachable":[]}}`);
    const card = P.of("mcp__phren__phren_admin", `{"action":"owner_inbox","operation":"list"}`, inbox)!;
    expect(card.verb).toBe("Owner inbox");
    expect(card.fields).toEqual([{ name: "operation", value: "list" }]);
    expect(card.detail).toEqual(PhrenToolPresentation.Detail.rows([{ header: null, rows: [row("Approve the merge", "needs you · phren · desk")] }]));
    const projects = text(`{"ok":true,"message":"# Phren Projects (2)","data":{"projects":[{"name":"phren","brief":"Memory for agents","fileCount":5},{"name":"hub","store":"team","brief":"Timesheets"}],"total":2}}`);
    const list = P.of("mcp__phren__phren_admin", `{"action":"list_projects"}`, projects);
    expect(list?.resultSummary).toBe("2 projects");
    expect(list?.detail).toEqual(PhrenToolPresentation.Detail.rows([{ header: null, rows: [
      row("phren", "Memory for agents"), row("hub", "Timesheets", "team"),
    ] }]));
    const summary = text(`{"ok":true,"message":"# phren","data":{"name":"phren","counts":{"findings":55,"openTasks":7}}}`);
    expect(P.of("mcp__phren__get_project_summary", `{"name":"phren"}`, summary)?.resultSummary).toBe("55 findings · 7 open tasks");
  });

  it("writesSayWhatTheyDidAndUnknownReadsKeepTheirOutput", () => {
    const added = text(`{"ok":true,"message":"Added 1 of 1 tasks to p","data":{"project":"p","added":["Fix"],"errors":[]}}`);
    expect(P.of("mcp__phren__add_task", `{"project":"p","item":"Fix"}`, added)?.resultSummary).toBe("Added 1 of 1 tasks to p");
    const health = P.of("mcp__phren__phren_admin", `{"action":"health_check"}`, text(`{"ok":true,"message":"Phren v1.2.3\\nProfile: default","data":{"version":"1.2.3"}}`))!;
    expect(health.verb).toBe("Health check");
    expect(health.resultSummary).toBe("Phren v1.2.3");
    expect(health.detail).toBeNull();
    expect(health.showsOutput).toBe(true);
    const failed = P.of("mcp__phren__phren_admin", `{"action":"list_projects"}`, `{"ok":false,"error":"Page 3 out of range. Total pages: 1."}`)!;
    expect(failed.detail).toBeNull();
    expect(failed.showsOutput).toBe(false);
  });
});
