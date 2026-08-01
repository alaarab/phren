import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { TreeDataSource } from "../src/providers/tree-data";
import { fakeClient, ok, deviceContext } from "./test-helpers";

// tree-data.ts imports readDeviceContext from ../profileConfig, which — for
// machine identity and the ~/.phren-context.md "active projects" fallback —
// reads from the *real* OS home directory regardless of the storePath passed
// in (see profileConfig.ts: MACHINE_ID_PATH/CONTEXT_PATH are computed from
// os.homedir() at module-load time, not from the storePath argument).
// Left unmocked, these tests would silently pick up whatever real
// ~/.phren-context.md happens to exist on the machine running them — exactly
// the kind of environment leakage that makes tests flaky across machines/CI.
// Mocking the module keeps TreeDataSource tests hermetic.
vi.mock("../src/profileConfig", () => ({
  readDeviceContext: vi.fn(() => ({ profile: "", activeProjects: new Set<string>(), machine: "test-machine", lastSync: "" })),
}));

import { readDeviceContext } from "../src/profileConfig";

const STORE_PATH = "/tmp/does-not-need-to-exist";

beforeEach(() => {
  vi.mocked(readDeviceContext).mockReturnValue(deviceContext());
  vscode.workspace.workspaceFolders = undefined;
});

describe("TreeDataSource.getRootSections", () => {
  it("always returns the 8 top-level sections in a stable order", async () => {
    const client = fakeClient({ listHooks: vi.fn(async () => ok({ tools: [] })) });
    const data = new TreeDataSource(client, STORE_PATH);
    const sections = await data.getRootSections(undefined);
    expect(sections.map((s) => (s.kind === "rootSection" ? s.section : s.kind))).toEqual([
      "projects", "tasks", "skills", "machines", "review", "hooks", "graph", "manage",
    ]);
  });

  it("hooks section description reflects enabled/total tool counts", async () => {
    const client = fakeClient({
      listHooks: vi.fn(async () => ok({ tools: [{ tool: "a", enabled: true }, { tool: "b", enabled: false }], globalEnabled: true })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const sections = await data.getRootSections(undefined);
    const hooks = sections.find((s) => s.kind === "rootSection" && s.section === "hooks");
    expect(hooks?.kind === "rootSection" && hooks.description).toBe("1/2 on");
  });

  it('hooks section description is "off" when hooks are globally disabled, "none" when there are no tools', async () => {
    const off = new TreeDataSource(
      fakeClient({ listHooks: vi.fn(async () => ok({ tools: [{ tool: "a", enabled: true }], globalEnabled: false })) }),
      STORE_PATH,
    );
    const offSections = await off.getRootSections(undefined);
    const offHooks = offSections.find((s) => s.kind === "rootSection" && s.section === "hooks");
    expect(offHooks?.kind === "rootSection" && offHooks.description).toBe("off");

    const none = new TreeDataSource(
      fakeClient({ listHooks: vi.fn(async () => ok({ tools: [], globalEnabled: true })) }),
      STORE_PATH,
    );
    const noneSections = await none.getRootSections(undefined);
    const noneHooks = noneSections.find((s) => s.kind === "rootSection" && s.section === "hooks");
    expect(noneHooks?.kind === "rootSection" && noneHooks.description).toBe("none");
  });

  it("swallows a hooks-fetch failure and leaves the description undefined rather than throwing", async () => {
    const client = fakeClient({ listHooks: vi.fn(async () => { throw new Error("boom"); }) });
    const data = new TreeDataSource(client, STORE_PATH);
    const sections = await data.getRootSections(undefined);
    const hooks = sections.find((s) => s.kind === "rootSection" && s.section === "hooks");
    expect(hooks?.kind === "rootSection" && hooks.description).toBeUndefined();
  });
});

describe("TreeDataSource findings", () => {
  it("getFindingDateGroups groups by date and counts, in first-seen order", async () => {
    const client = fakeClient({
      getFindings: vi.fn(async () => ok({
        findings: [
          { id: "1", text: "a", date: "2026-01-02" },
          { id: "2", text: "b", date: "2026-01-01" },
          { id: "3", text: "c", date: "2026-01-02" },
        ],
      })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const groups = await data.getFindingDateGroups("app", undefined);
    expect(groups).toEqual([
      { kind: "findingDateGroup", projectName: "app", date: "2026-01-02", count: 2 },
      { kind: "findingDateGroup", projectName: "app", date: "2026-01-01", count: 1 },
    ]);
  });

  it("getFindingDateGroups shows an empty-state message, worded differently when a date filter is active", async () => {
    const client = fakeClient();
    const data = new TreeDataSource(client, STORE_PATH);
    const noFilter = await data.getFindingDateGroups("app", undefined);
    expect(noFilter).toEqual([{ kind: "message", label: "No findings", iconId: "list-flat" }]);
    const withFilter = await data.getFindingDateGroups("app", { label: "Today", from: "2026-01-01", to: "2026-01-01" });
    expect(withFilter).toEqual([{ kind: "message", label: "No findings in date range", iconId: "list-flat" }]);
  });

  it("date filter excludes findings with an unknown date and those outside the [from, to] range", async () => {
    const client = fakeClient({
      getFindings: vi.fn(async () => ok({
        findings: [
          { id: "1", text: "in range", date: "2026-01-15" },
          { id: "2", text: "too early", date: "2026-01-01" },
          { id: "3", text: "too late", date: "2026-02-01" },
          { id: "4", text: "no date at all" }, // → date becomes "unknown"
        ],
      })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const groups = await data.getFindingDateGroups("app", { label: "mid-Jan", from: "2026-01-10", to: "2026-01-20" });
    expect(groups).toEqual([{ kind: "findingDateGroup", projectName: "app", date: "2026-01-15", count: 1 }]);
  });

  it("getFindingsForDate returns full finding nodes filtered to the requested date", async () => {
    const client = fakeClient({
      getFindings: vi.fn(async () => ok({
        findings: [
          { id: "1", text: "keep", date: "2026-01-01", type: "decision", confidence: 0.9 },
          { id: "2", text: "drop", date: "2026-01-02" },
        ],
      })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const findings = await data.getFindingsForDate("app", "2026-01-01", undefined);
    expect(findings).toEqual([
      { kind: "finding", projectName: "app", id: "1", date: "2026-01-01", text: "keep", type: "decision", confidence: 0.9, supersededBy: undefined, supersedes: undefined, contradicts: undefined, potentialDuplicates: undefined },
    ]);
  });

  it("wraps a client failure into a single warning message node instead of throwing", async () => {
    const client = fakeClient({ getFindings: vi.fn(async () => { throw new Error("network down"); }) });
    const data = new TreeDataSource(client, STORE_PATH);
    const groups = await data.getFindingDateGroups("app", undefined);
    expect(groups).toEqual([{ kind: "message", label: "Failed to load findings", description: "network down", iconId: "warning" }]);
  });

  it("drops findings missing an id or text instead of crashing on malformed entries", async () => {
    const client = fakeClient({
      getFindings: vi.fn(async () => ok({ findings: [{ id: "1" }, { text: "no id" }, { id: "2", text: "ok", date: "2026-01-01" }] })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const groups = await data.getFindingDateGroups("app", undefined);
    expect(groups).toEqual([{ kind: "findingDateGroup", projectName: "app", date: "2026-01-01", count: 1 }]);
  });
});

describe("TreeDataSource notes", () => {
  it("getNoteDateGroups groups and counts; getNotesForDate filters to that date", async () => {
    const client = fakeClient({
      getNotes: vi.fn(async () => ok({
        notes: [
          { id: "n1", text: "a", date: "2026-01-01", time: "09:00:00" },
          { id: "n2", text: "b", date: "2026-01-01", time: "10:00:00" },
          { id: "n3", text: "c", date: "2026-01-02", time: "11:00:00" },
        ],
      })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    expect(await data.getNoteDateGroups("app")).toEqual([
      { kind: "noteDateGroup", projectName: "app", date: "2026-01-01", count: 2 },
      { kind: "noteDateGroup", projectName: "app", date: "2026-01-02", count: 1 },
    ]);
    const forDate = await data.getNotesForDate("app", "2026-01-01");
    expect(forDate.map((n) => (n.kind === "note" ? n.id : undefined))).toEqual(["n1", "n2"]);
  });

  it('getNoteDateGroups reports "No notes yet" when there are none', async () => {
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    expect(await data.getNoteDateGroups("app")).toEqual([{ kind: "message", label: "No notes yet", iconId: "note" }]);
  });

  it("drops notes missing id, text, or date", async () => {
    const client = fakeClient({
      getNotes: vi.fn(async () => ok({ notes: [{ id: "n1", text: "ok", date: "2026-01-01" }, { id: "n2", text: "no date" }, { text: "no id", date: "2026-01-01" }] })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    expect(await data.getNoteDateGroups("app")).toEqual([{ kind: "noteDateGroup", projectName: "app", date: "2026-01-01", count: 1 }]);
  });
});

describe("TreeDataSource global task board", () => {
  function tasksResponse(projects: Array<{ project: string; Active?: unknown[]; Queue?: unknown[] }>) {
    return ok({
      projects: projects.map((p) => ({ project: p.project, items: { Active: p.Active ?? [], Queue: p.Queue ?? [] } })),
    });
  }

  it("splits into Pinned / Active / Queue groups, excluding pinned items from their raw section", async () => {
    const client = fakeClient({
      getAllTasks: vi.fn(async () => tasksResponse([
        { project: "app", Active: [{ id: "1", line: "pinned active", pinned: true }, { id: "2", line: "plain active" }], Queue: [{ id: "3", line: "queued" }] },
      ])),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const groups = await data.getGlobalTaskBoard();
    expect(groups).toEqual([
      { kind: "globalTaskSectionGroup", section: "Pinned", count: 1 },
      { kind: "globalTaskSectionGroup", section: "Active", count: 1 },
      { kind: "globalTaskSectionGroup", section: "Queue", count: 1 },
    ]);
  });

  it('shows "No tasks across any project" when every project is empty', async () => {
    const client = fakeClient({ getAllTasks: vi.fn(async () => tasksResponse([])) });
    const data = new TreeDataSource(client, STORE_PATH);
    expect(await data.getGlobalTaskBoard()).toEqual([{ kind: "message", label: "No tasks across any project", iconId: "checklist" }]);
  });

  it("getGlobalTasksForSection returns only pinned items for Pinned regardless of their underlying section", async () => {
    const client = fakeClient({
      getAllTasks: vi.fn(async () => tasksResponse([
        { project: "app", Active: [{ id: "1", line: "pinned", pinned: true }] },
        { project: "app2", Queue: [{ id: "2", line: "also pinned", pinned: true }] },
      ])),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const pinned = await data.getGlobalTasksForSection("Pinned");
    expect(pinned.map((t) => (t.kind === "task" ? t.projectName : undefined))).toEqual(["app", "app2"]);
  });

  it("generates a stable fallback id from section+index when the server omits one", async () => {
    const client = fakeClient({ getAllTasks: vi.fn(async () => tasksResponse([{ project: "app", Active: [{ line: "no id here" }] }])) }) ;
    const data = new TreeDataSource(client, STORE_PATH);
    const tasks = await data.getGlobalTasksForSection("Active");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind === "task" && tasks[0].id).toBe("Active-1");
  });
});

describe("TreeDataSource per-project tasks and queue", () => {
  it("getTaskSectionGroups counts each section and omits empty ones", async () => {
    const client = fakeClient({
      getTasks: vi.fn(async () => ok({ items: { Active: [{ id: "1", line: "a" }], Queue: [], Done: [{ id: "2", line: "b", checked: true }] } })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    expect(await data.getTaskSectionGroups("app")).toEqual([
      { kind: "taskSectionGroup", projectName: "app", section: "Active", count: 1 },
      { kind: "taskSectionGroup", projectName: "app", section: "Done", count: 1 },
    ]);
  });

  it("Done tasks default checked to true even if the server omits the flag", async () => {
    const client = fakeClient({ getTasks: vi.fn(async () => ok({ items: { Done: [{ id: "1", line: "b" }] } })) });
    const data = new TreeDataSource(client, STORE_PATH);
    const tasks = await data.getTasksForSection("app", "Done");
    expect(tasks[0].kind === "task" && tasks[0].checked).toBe(true);
  });

  it("getQueueSectionGroups / getAggregateQueueSectionGroups count per section and omit empty ones", async () => {
    const client = fakeClient({
      getReviewQueue: vi.fn(async () => ok({
        items: [
          { id: "1", project: "app", text: "a", section: "Review" },
          { id: "2", project: "app", text: "b", section: "Conflicts" },
          { id: "3", project: "app", text: "c", section: "Conflicts" },
        ],
      })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    expect(await data.getQueueSectionGroups("app")).toEqual([
      { kind: "queueSectionGroup", projectName: "app", section: "Review", count: 1 },
      { kind: "queueSectionGroup", projectName: "app", section: "Conflicts", count: 2 },
    ]);
    expect(await data.getAggregateQueueSectionGroups()).toEqual([
      { kind: "aggregateQueueSectionGroup", section: "Review", count: 1 },
      { kind: "aggregateQueueSectionGroup", section: "Conflicts", count: 2 },
    ]);
  });

  it("an unrecognized section value falls back to Review instead of being dropped or crashing", async () => {
    const client = fakeClient({ getReviewQueue: vi.fn(async () => ok({ items: [{ id: "1", project: "app", text: "a", section: "Bogus" }] })) });
    const data = new TreeDataSource(client, STORE_PATH);
    const items = await data.getQueueItemsForSection("app", "Review");
    expect(items).toHaveLength(1);
  });

  it("getQueueItemsForSection hides the project name; the aggregate variant shows it", async () => {
    const client = fakeClient({ getReviewQueue: vi.fn(async () => ok({ items: [{ id: "1", project: "app", text: "a", section: "Review" }] })) });
    const data = new TreeDataSource(client, STORE_PATH);
    const scoped = await data.getQueueItemsForSection("app", "Review");
    expect(scoped[0].kind === "queueItem" && scoped[0].showProjectName).toBe(false);
    const aggregate = await data.getAggregateQueueItemsForSection("Review");
    expect(aggregate[0].kind === "queueItem" && aggregate[0].showProjectName).toBe(true);
  });

  it("getReviewProjectGroups sorts conflict-heavy projects first, ties broken by total volume", async () => {
    const client = fakeClient({
      getReviewQueue: vi.fn(async () => ok({
        items: [
          { id: "1", project: "quiet", text: "a", section: "Review" },
          { id: "2", project: "busy", text: "b", section: "Review" },
          { id: "3", project: "busy", text: "c", section: "Review" },
          { id: "4", project: "onfire", text: "d", section: "Conflicts" },
        ],
      })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const groups = await data.getReviewProjectGroups();
    expect(groups.map((g) => (g.kind === "reviewProjectGroup" ? g.projectName : undefined))).toEqual(["onfire", "busy", "quiet"]);
  });
});

describe("TreeDataSource sessions", () => {
  it("getSessionDateGroups groups sessions by date; getSessionsForDate filters and shapes them", async () => {
    const client = fakeClient({
      sessionHistory: vi.fn(async () => ok([
        { sessionId: "s1", startedAt: "2026-01-01T09:00:00Z", status: "ended", findingsAdded: 2 },
        { sessionId: "s2", startedAt: "2026-01-01T10:00:00Z", status: "active", findingsAdded: 0 },
      ])),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    expect(await data.getSessionDateGroups("app")).toEqual([{ kind: "sessionDateGroup", projectName: "app", date: "2026-01-01", count: 2 }]);
    const sessions = await data.getSessionsForDate("app", "2026-01-01");
    expect(sessions.map((s) => (s.kind === "session" ? s.sessionId : undefined))).toEqual(["s1", "s2"]);
  });

  it("drops sessions missing sessionId, startedAt, or a valid status", async () => {
    const client = fakeClient({
      sessionHistory: vi.fn(async () => ok([
        { sessionId: "s1", startedAt: "2026-01-01T09:00:00Z", status: "ended" },
        { sessionId: "s2", startedAt: "2026-01-01T09:00:00Z", status: "bogus-status" },
        { startedAt: "2026-01-01T09:00:00Z", status: "ended" },
      ])),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const sessions = await data.getSessionsForDate("app", "2026-01-01");
    expect(sessions).toHaveLength(1);
  });

  it("getSessionChildren buckets findings/tasks and reports an empty message when a session captured neither", async () => {
    const client = fakeClient({
      sessionHistory: vi.fn(async () => ok({ findings: [{ id: "f1", text: "x", date: "2026-01-01" }], tasks: [] })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const children = await data.getSessionChildren({ kind: "session", projectName: "app", date: "2026-01-01", sessionId: "s1", startedAt: "2026-01-01T09:00:00Z", findingsAdded: 1, status: "ended" });
    expect(children).toEqual([{ kind: "sessionBucket", projectName: "app", sessionId: "s1", bucket: "findings", count: 1 }]);
  });

  it("getSessionBucketChildren returns full finding/task nodes for the requested bucket", async () => {
    const client = fakeClient({
      sessionHistory: vi.fn(async () => ok({ findings: [], tasks: [{ id: "t1", text: "ship it", section: "Active" }] })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const children = await data.getSessionBucketChildren({ kind: "sessionBucket", projectName: "app", sessionId: "s1", bucket: "tasks", count: 1 });
    expect(children).toEqual([{ kind: "task", projectName: "app", id: "t1", line: "ship it", section: "Active", checked: false }]);
  });
});

describe("TreeDataSource truths and reference docs", () => {
  it("getTruthNodes filters out non-string entries", async () => {
    const client = fakeClient({ getTruths: vi.fn(async () => ok({ truths: ["real truth", 42, null] })) });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getTruthNodes("app");
    expect(nodes).toEqual([{ kind: "truth", projectName: "app", text: "real truth" }]);
  });

  it("getReferenceNodes only surfaces files under reference/ (either slash style) and strips the prefix", async () => {
    const client = fakeClient({
      getProjectSummary: vi.fn(async () => ok({
        files: [
          { name: "reference/setup.md" },
          { name: "reference\\windows.md" },
          { name: "FINDINGS.md" },
          "reference/legacy-string-entry.md",
        ],
      })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getReferenceNodes("app");
    expect(nodes.map((n) => (n.kind === "referenceFile" ? n.fileName : undefined))).toEqual([
      "setup.md", "windows.md", "legacy-string-entry.md",
    ]);
  });
});

describe("TreeDataSource skills and hooks", () => {
  it("getSkillGroupNodes always sorts the global group first, others alphabetically", async () => {
    const client = fakeClient({
      listSkills: vi.fn(async () => ok({ skills: [
        { name: "s1", source: "zeta-project" }, { name: "s2", source: "global" }, { name: "s3", source: "alpha-project" },
      ] })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const groups = await data.getSkillGroupNodes();
    expect(groups.map((g) => (g.kind === "skillGroup" ? g.source : undefined))).toEqual(["global", "alpha-project", "zeta-project"]);
  });

  it("getHookNodes combines tool hooks, custom hooks (webhook vs command target), and the last 5 hook errors", async () => {
    const client = fakeClient({
      listHooks: vi.fn(async () => ok({
        tools: [{ tool: "claude-code", enabled: true }],
        customHooks: [
          { event: "PreToolUse", webhook: "https://example.com/hook", timeout: 5000 },
          { event: "PostToolUse", command: "./notify.sh" },
        ],
      })),
      listHookErrors: vi.fn(async () => ok({ errors: Array.from({ length: 7 }, (_, i) => ({ timestamp: `t${i}`, event: "PreToolUse", message: `err${i}` })) })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getHookNodes();
    expect(nodes.filter((n) => n.kind === "hook")).toEqual([{ kind: "hook", tool: "claude-code", enabled: true }]);
    const webhookNode = nodes.find((n) => n.kind === "customHook" && n.event === "PreToolUse");
    expect(webhookNode?.kind === "customHook" && webhookNode.isWebhook).toBe(true);
    const commandNode = nodes.find((n) => n.kind === "customHook" && n.event === "PostToolUse");
    expect(commandNode?.kind === "customHook" && commandNode.isWebhook).toBe(false);
    const errors = nodes.filter((n) => n.kind === "hookError");
    expect(errors).toHaveLength(5);
    expect(errors[0].kind === "hookError" && errors[0].message).toBe("err2"); // slice(-5) → drops the oldest 2
  });

  it("getProjectHookNodes maps the tri-state override (inherit/on/off)", async () => {
    const client = fakeClient({
      listHooks: vi.fn(async () => ok({ projectHooks: { events: [
        { event: "PreToolUse", enabled: true, configured: null },
        { event: "PostToolUse", enabled: false, configured: false },
      ] } })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getProjectHookNodes("app");
    expect(nodes).toEqual([
      { kind: "projectHookEvent", projectName: "app", event: "PreToolUse", enabled: true, configured: null },
      { kind: "projectHookEvent", projectName: "app", event: "PostToolUse", enabled: false, configured: false },
    ]);
  });
});

describe("TreeDataSource.detectActiveProject (pure, workspace-folder based)", () => {
  const projects = [
    { name: "app-one", source: "/Users/dev/app-one" },
    { name: "app-two" },
  ];

  it("matches by exact source path first", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/Users/dev/app-one" } }];
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    expect(data.detectActiveProject(projects)).toBe("app-one");
  });

  it("falls back to matching the project name against the workspace folder's basename", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/Users/dev/app-two" } }];
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    expect(data.detectActiveProject(projects)).toBe("app-two");
  });

  it("returns undefined when there is no workspace open or nothing matches", () => {
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    vscode.workspace.workspaceFolders = undefined;
    expect(data.detectActiveProject(projects)).toBeUndefined();
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/Users/dev/unrelated-folder" } }];
    expect(data.detectActiveProject(projects)).toBeUndefined();
  });
});

describe("TreeDataSource.sortWithActiveFirst (pure)", () => {
  it("moves the active project to the front without reordering the rest", () => {
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    const projects = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const nodes = data.sortWithActiveFirst(projects, "c", undefined);
    expect(nodes.map((n) => n.projectName)).toEqual(["c", "a", "b"]);
    expect(nodes.find((n) => n.projectName === "c")?.active).toBe(true);
  });

  it("leaves order untouched when no project is active", () => {
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    const projects = [{ name: "a" }, { name: "b" }];
    const nodes = data.sortWithActiveFirst(projects, undefined, undefined);
    expect(nodes.map((n) => n.projectName)).toEqual(["a", "b"]);
    expect(nodes.every((n) => !n.active)).toBe(true);
  });
});

describe("TreeDataSource.getProjectNodes", () => {
  it('shows the "add one" message when there are no projects at all', async () => {
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    const nodes = await data.getProjectNodes();
    expect(nodes).toEqual([{ kind: "message", label: "No projects yet — click + to add one", description: "", iconId: "add" }]);
  });

  it("groups by store when projects span more than one store", async () => {
    const client = fakeClient({
      listProjects: vi.fn(async () => ok({ projects: [{ name: "a", store: "personal" }, { name: "b", store: "team" }] })),
      storeList: vi.fn(async () => ok({ stores: [{ name: "personal", role: "primary" }, { name: "team", role: "team" }] })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getProjectNodes();
    expect(nodes.map((n) => (n.kind === "storeGroup" ? n.storeName : undefined))).toEqual(["personal", "team"]);
  });

  it("splits into device/other groups using the device context's active-project set when single-store", async () => {
    vi.mocked(readDeviceContext).mockReturnValue(deviceContext({ activeProjects: new Set(["a"]) }));
    const client = fakeClient({
      listProjects: vi.fn(async () => ok({ projects: [{ name: "a" }, { name: "b" }] })),
    });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getProjectNodes();
    expect(nodes).toEqual([
      { kind: "projectGroup", group: "device", count: 1 },
      { kind: "projectGroup", group: "other", count: 1 },
    ]);
  });

  it("returns a flat active-first list (no device split) when the device context has no active-project set", async () => {
    const client = fakeClient({ listProjects: vi.fn(async () => ok({ projects: [{ name: "a" }, { name: "b" }] })) });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getProjectNodes();
    expect(nodes.every((n) => n.kind === "project")).toBe(true);
  });
});

describe("TreeDataSource.getManageNodes / getMachineNodes", () => {
  it("shows per-store sync rows when stores are configured", async () => {
    const client = fakeClient({ storeList: vi.fn(async () => ok({ stores: [{ name: "team", role: "team", sync: "pull", lastSync: undefined }] })) });
    const data = new TreeDataSource(client, STORE_PATH);
    const nodes = await data.getManageNodes(true);
    expect(nodes[0]).toEqual({ kind: "manageItem", item: "health", label: "Health", value: "ok" });
    expect(nodes[1]).toMatchObject({ kind: "manageItem", item: "storeSync", storeName: "team" });
  });

  it("falls back to the device context's lastSync when there are no stores", async () => {
    vi.mocked(readDeviceContext).mockReturnValue(deviceContext({ lastSync: "2026-01-01" }));
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    const nodes = await data.getManageNodes(undefined);
    expect(nodes[1]).toEqual({ kind: "manageItem", item: "lastSync", label: "Sync", value: "2026-01-01" });
  });

  it("getMachineNodes surfaces the machine alias and its mapped profile", () => {
    vi.mocked(readDeviceContext).mockReturnValue(deviceContext({ machine: "my-laptop", profile: "work" }));
    const data = new TreeDataSource(fakeClient(), STORE_PATH);
    expect(data.getMachineNodes()).toEqual([
      { kind: "manageItem", item: "machine", label: "Machine", value: "my-laptop" },
      { kind: "manageItem", item: "profile", label: "Profile", value: "my-laptop → work" },
    ]);
  });
});

describe("TreeDataSource caching", () => {
  it("cachedFetch reuses the first result for a given key instead of calling the client again", async () => {
    const listProjects = vi.fn(async () => ok({ projects: [{ name: "a" }] }));
    const data = new TreeDataSource(fakeClient({ listProjects }), STORE_PATH);
    await data.fetchProjects();
    await data.fetchProjects();
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it("clearCache bumps the generation and forces the next fetch to hit the client again", async () => {
    const listProjects = vi.fn(async () => ok({ projects: [{ name: "a" }] }));
    const data = new TreeDataSource(fakeClient({ listProjects }), STORE_PATH);
    const genBefore = data.getCacheGeneration();
    await data.fetchProjects();
    data.clearCache();
    expect(data.getCacheGeneration()).toBe(genBefore + 1);
    await data.fetchProjects();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });
});
