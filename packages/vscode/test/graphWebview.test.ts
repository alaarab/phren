import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

// loadGraphData() also folds in ~/.phren/.runtime/memory-scores.json (via the
// module-private loadMemoryScores(), called fresh on every loadGraphData()
// run), reading from os.homedir() — real vscode.ThemeIcon.Folder/File aside,
// this is the module's only other point of contact with the real machine.
// This machine has a live phren store, so left unmocked these tests could
// pick up real scoring data. os's ESM namespace isn't spy-able directly
// (vi.spyOn throws "Module namespace is not configurable in ESM"), so this
// mocks the module instead of the export, pointing homedir() at a sentinel
// path that can never resolve to a real file — loadMemoryScores()'s own
// try/catch already treats a missing file as "no scores", which is exactly
// the deterministic empty state these tests want.
const { PHREN_TEST_SENTINEL_HOME } = vi.hoisted(() => ({
  PHREN_TEST_SENTINEL_HOME: "/nonexistent/phren-graphwebview-test-home",
}));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => PHREN_TEST_SENTINEL_HOME };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => PHREN_TEST_SENTINEL_HOME };
});

import {
  buildScoreKey,
  classifyFindingTopic,
  computeMtimeKey,
  fetchEntities,
  fetchFindings,
  fetchProjectSummary,
  fetchProjects,
  fetchTasks,
  fetchTopicConfig,
  isValidProjectName,
  loadGraphData,
  qualityMultiplierFromEntry,
  showGraphWebview,
} from "../src/graphWebview";
import type { PhrenClient } from "../src/phrenClient";
import { fakeClient, ok } from "./test-helpers";

describe("isValidProjectName", () => {
  it("accepts lowercase alphanumeric names with hyphens/underscores", () => {
    expect(isValidProjectName("app")).toBe(true);
    expect(isValidProjectName("my-project_2")).toBe(true);
  });

  it("rejects empty, oversized, and path-traversal-shaped names", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("a".repeat(101))).toBe(false);
    expect(isValidProjectName("../etc")).toBe(false);
    expect(isValidProjectName("a/b")).toBe(false);
    expect(isValidProjectName("a\\b")).toBe(false);
    expect(isValidProjectName("a\0b")).toBe(false);
  });

  it("rejects names that don't start with a lowercase letter or digit", () => {
    expect(isValidProjectName("-app")).toBe(false);
    expect(isValidProjectName("_app")).toBe(false);
    expect(isValidProjectName("App")).toBe(false); // uppercase not in the character class at all
  });
});

describe("computeMtimeKey", () => {
  it("returns an empty string for a store path that doesn't exist", () => {
    expect(computeMtimeKey("/does/not/exist/at/all")).toBe("");
  });

  it("changes when a tracked file's mtime changes, and ignores dotfile directories", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "phren-mtime-"));
    try {
      fs.mkdirSync(path.join(store, "app"));
      fs.writeFileSync(path.join(store, "app", "FINDINGS.md"), "a");
      fs.mkdirSync(path.join(store, ".config")); // dotdir — must be ignored
      fs.writeFileSync(path.join(store, ".config", "FINDINGS.md"), "should not count");

      const before = computeMtimeKey(store);
      // Bump mtime forward enough to guarantee a detectable change on any FS mtime resolution.
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(store, "app", "FINDINGS.md"), future, future);
      const after = computeMtimeKey(store);

      expect(before).not.toBe(after);
      expect(before).not.toContain(".config");
      expect(after).not.toContain(".config");
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});

describe("classifyFindingTopic", () => {
  it("falls back to general when nothing matches", () => {
    // Nonsense tokens: matching is a plain lowercased substring test with no
    // word-boundary awareness, so real English words risk accidental hits
    // (e.g. "quick" contains frontend's "ui" keyword as a substring — not a
    // bug worth changing here, since re-tuning the classifier is a much
    // bigger behavioral change than this pass is scoped for, but worth
    // avoiding in the fixture rather than tripping over it).
    expect(classifyFindingTopic("zzz qqq xyzzy plugh")).toEqual({ slug: "general", label: "General" });
  });

  it("picks the builtin category with the most keyword hits", () => {
    // "database" keywords hit here: database, sql, query, index, migration (5)
    // "performance" keywords hit here: performance (1)
    const topic = classifyFindingTopic("the database sql query needs an index before the migration; also a performance note");
    expect(topic.slug).toBe("database");
  });

  it("lets project-specific topics override a builtin slug's keyword set", () => {
    // "api" is a builtin slug whose keywords don't include "widget"; a
    // project topic reusing the "api" slug with "widget" as a keyword should
    // win instead of falling through to the builtin's (non-matching) list.
    const topic = classifyFindingTopic("our widget needs work", [{ slug: "api", label: "Custom API", keywords: ["widget"] }]);
    expect(topic).toEqual({ slug: "api", label: "Custom API" });
  });

  it("lets project topics introduce entirely new slugs", () => {
    const topic = classifyFindingTopic("the sprocket is loose", [{ slug: "hardware", label: "Hardware", keywords: ["sprocket"] }]);
    expect(topic).toEqual({ slug: "hardware", label: "Hardware" });
  });
});

describe("qualityMultiplierFromEntry", () => {
  it("returns undefined when there is no score entry", () => {
    expect(qualityMultiplierFromEntry(undefined)).toBeUndefined();
  });

  it("boosts recently-used, well-liked entries and clamps at 1.5", () => {
    const value = qualityMultiplierFromEntry({
      impressions: 100, helpful: 20, repromptPenalty: 0, regressionPenalty: 0,
      lastUsedAt: new Date().toISOString(),
    });
    expect(value).toBe(1.5);
  });

  it("penalizes stale, poorly-received entries and clamps at 0.2", () => {
    const value = qualityMultiplierFromEntry({
      impressions: 0, helpful: 0, repromptPenalty: 10, regressionPenalty: 10,
      lastUsedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(), // well over a year stale
    });
    expect(value).toBe(0.2);
  });

  it("applies zero recency boost in the 8-30 day window", () => {
    const value = qualityMultiplierFromEntry({
      impressions: 0, helpful: 0, repromptPenalty: 0, regressionPenalty: 0,
      lastUsedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
    });
    // No impressions/helpful/penalties and mid-window recency → multiplier is exactly the 1 + 0 baseline.
    expect(value).toBe(1);
  });
});

describe("buildScoreKey", () => {
  it("is deterministic and namespaced by project/filename", () => {
    const a = buildScoreKey("app", "FINDINGS.md", "the finding text");
    const b = buildScoreKey("app", "FINDINGS.md", "the finding text");
    expect(a).toBe(b);
    expect(a).toMatch(/^app\/FINDINGS\.md:[0-9a-f]{12}$/);
  });

  it("changes when the project, filename, or snippet changes", () => {
    const base = buildScoreKey("app", "FINDINGS.md", "text");
    expect(buildScoreKey("other", "FINDINGS.md", "text")).not.toBe(base);
    expect(buildScoreKey("app", "tasks.md", "text")).not.toBe(base);
    expect(buildScoreKey("app", "FINDINGS.md", "different")).not.toBe(base);
  });

  it("only hashes the first 160 characters, so longer snippets that share a prefix collide", () => {
    const long = "x".repeat(200);
    const longButDifferentTail = `${"x".repeat(160)}${"y".repeat(40)}`;
    expect(buildScoreKey("app", "FINDINGS.md", long)).toBe(buildScoreKey("app", "FINDINGS.md", longButDifferentTail));
  });
});

describe("fetchProjects", () => {
  it("filters out path-shaped, reserved, and known-stale project names, and dedupes by name", async () => {
    const client = fakeClient({
      listProjects: vi.fn(async () => ok({
        projects: [
          { name: "app" },
          { name: "weird:name" },
          { name: "a/b" },
          { name: "a\\b" },
          { name: "global" },
          { name: "scripts" },
          { name: "templates" },
          { name: "profiles" },
          { name: "dendron" },
          { name: "phren-framework" },
          { name: "app", brief: "second occurrence, should be dropped" },
          { name: "other", brief: "ok", store: "team" },
        ],
      })),
    });
    const projects = await fetchProjects(client);
    expect(projects).toEqual([{ name: "app", brief: undefined, store: undefined }, { name: "other", brief: "ok", store: "team" }]);
  });
});

describe("fetchProjectSummary", () => {
  it("defaults name/summary and only keeps files with both a filename and a type", async () => {
    const client = fakeClient({
      getProjectSummary: vi.fn(async () => ok({
        files: [{ filename: "reference/x.md", type: "reference" }, { name: "y.md", type: "note" }, { filename: "no-type.md" }],
      })),
    });
    const summary = await fetchProjectSummary(client, "app");
    expect(summary.name).toBe("app");
    expect(summary.summary).toBe("No summary.md found.");
    expect(summary.files).toEqual([{ filename: "reference/x.md", type: "reference" }, { filename: "y.md", type: "note" }]);
  });
});

describe("fetchFindings", () => {
  it("skips textless entries, classifies each finding's topic, and falls back total to the parsed count", async () => {
    const client = fakeClient({
      getFindings: vi.fn(async () => ok({
        findings: [
          { text: "the database sql query is slow" },
          { text: "" },
          { stableId: "stable-1", text: "another finding" },
        ],
      })),
    });
    const page = await fetchFindings(client, "app");
    expect(page.findings).toHaveLength(2);
    expect(page.findings[0].topicSlug).toBe("database");
    expect(page.findings[1].id).toBe("stable-1"); // falls back to stableId when the server omits id
    expect(page.total).toBe(2); // no numeric data.total in the response → falls back to parsed.length
  });

  it("prefers the server's reported total over the parsed page length when present", async () => {
    const client = fakeClient({ getFindings: vi.fn(async () => ok({ findings: [{ text: "one" }], total: 500 })) });
    const page = await fetchFindings(client, "app");
    expect(page.total).toBe(500);
  });
});

describe("fetchTopicConfig", () => {
  it("requires a slug, defaults label to the slug, and drops an empty keyword list to undefined", async () => {
    const client = fakeClient({
      getTopicConfig: vi.fn(async () => ok({ topics: [{ slug: "api" }, { label: "no slug, dropped" }, { slug: "db", label: "Database", keywords: ["sql"] }] })),
    });
    const topics = await fetchTopicConfig(client, "app");
    expect(topics).toEqual([{ slug: "api", label: "api", keywords: undefined }, { slug: "db", label: "Database", keywords: ["sql"] }]);
  });

  it("swallows a client failure and returns an empty list instead of throwing", async () => {
    const client = fakeClient({ getTopicConfig: vi.fn(async () => { throw new Error("nope"); }) });
    await expect(fetchTopicConfig(client, "app")).resolves.toEqual([]);
  });
});

describe("fetchTasks", () => {
  it("includes all Active/Queue items but caps Done at 10, always marking Done as checked", async () => {
    const client = fakeClient({
      getTasks: vi.fn(async () => ok({
        items: {
          Active: [{ id: "a1", line: "active one" }],
          Queue: [],
          Done: Array.from({ length: 15 }, (_, i) => ({ id: `d${i}`, line: `done ${i}`, checked: false })),
        },
      })),
    });
    const tasks = await fetchTasks(client, "app");
    const done = tasks.filter((t) => t.section === "Done");
    expect(tasks.filter((t) => t.section === "Active")).toHaveLength(1);
    expect(done).toHaveLength(10);
    expect(done.every((t) => t.checked)).toBe(true);
  });
});

describe("fetchEntities", () => {
  it("defaults refCount to 0, filters docs to strings, and swallows failures", async () => {
    const client = fakeClient({
      readGraph: vi.fn(async () => ok({ fragments: [{ name: "Redis", docs: ["app/FINDINGS.md", 42, null] }] })),
    });
    const entities = await fetchEntities(client);
    expect(entities).toEqual([{ id: undefined, name: "Redis", type: "unknown", refCount: 0, docs: ["app/FINDINGS.md"] }]);

    const failing = fakeClient({ readGraph: vi.fn(async () => { throw new Error("nope"); }) });
    await expect(fetchEntities(failing)).resolves.toEqual([]);
  });
});

describe("loadGraphData: orchestration", () => {
  function clientWith(overrides: Record<string, unknown>) {
    return fakeClient({
      listProjects: vi.fn(async () => ok({ projects: [{ name: "app" }, { name: "empty-project" }] })),
      getProjectSummary: vi.fn(async () => ok({ name: "app", summary: "the app" })),
      getFindings: vi.fn(async () => ok({ findings: [{ id: "f1", text: "a finding", date: "2026-01-01" }] })),
      getTasks: vi.fn(async () => ok({ items: { Active: [{ id: "t1", line: "a task" }] } })),
      getTopicConfig: vi.fn(async () => ok({ topics: [] })),
      readGraph: vi.fn(async () => ok({ fragments: [] })),
      ...overrides,
    });
  }

  it("skips a project with zero findings and zero tasks entirely (no orphan node)", async () => {
    const client = clientWith({
      getFindings: vi.fn(async (project: string) => ok({ findings: project === "app" ? [{ id: "f1", text: "a finding", date: "2026-01-01" }] : [] })),
      getTasks: vi.fn(async (project: string) => ok({ items: project === "app" ? { Active: [{ id: "t1", line: "a task" }] } : {} })),
    });
    const data = await loadGraphData(client);
    expect(data.nodes.some((n) => n.projectName === "empty-project")).toBe(false);
    expect(data.summaries["empty-project"]).toBeUndefined();
    expect(data.summaries.app).toBeDefined();
  });

  it("builds project/finding/task nodes with edges from the project to each, and records findingCount/taskCount", async () => {
    const client = clientWith({});
    const data = await loadGraphData(client);

    const project = data.nodes.find((n) => n.kind === "project" && n.projectName === "app")!;
    const finding = data.nodes.find((n) => n.kind === "finding")!;
    const task = data.nodes.find((n) => n.kind === "task")!;
    expect(project.findingCount).toBe(1);
    expect(project.taskCount).toBe(1);
    expect(data.edges).toContainEqual({ source: project.id, target: finding.id });
    expect(data.edges).toContainEqual({ source: project.id, target: task.id });
  });

  it("only connects an entity to projects whose docs are prefixed with projectName + '/' (not merely a string-prefix match)", async () => {
    const client = clientWith({
      listProjects: vi.fn(async () => ok({ projects: [{ name: "app" }, { name: "app-extended" }] })),
      readGraph: vi.fn(async () => ok({ fragments: [{ name: "Thing", docs: ["app/FINDINGS.md"] }] })),
    });
    const data = await loadGraphData(client);
    const entity = data.nodes.find((n) => n.kind === "entity")!;
    // Must connect to "app" only — "app-extended" starting with the same
    // characters must not be treated as a prefix match ("app-extended/x"
    // would be, "app/FINDINGS.md" is not a doc under "app-extended/").
    expect(entity.connectedProjects).toEqual(["app"]);
  });

  it("adds cross-project edges when one entity connects more than one project, and dedupes reference doc nodes", async () => {
    const client = clientWith({
      listProjects: vi.fn(async () => ok({ projects: [{ name: "app" }, { name: "other" }] })),
      getFindings: vi.fn(async () => ok({ findings: [{ id: "f1", text: "x", date: "2026-01-01" }] })),
      getTasks: vi.fn(async () => ok({ items: {} })),
      readGraph: vi.fn(async () => ok({
        fragments: [
          { name: "Shared", docs: ["app/reference/x.md", "other/reference/x.md"] },
        ],
      })),
    });
    const data = await loadGraphData(client);
    const entity = data.nodes.find((n) => n.kind === "entity")!;
    expect(entity.connectedProjects.sort()).toEqual(["app", "other"]);
    expect(data.edges).toContainEqual({ source: "project:app", target: "project:other" });
    // Two distinct docs → two distinct reference nodes, not deduplicated
    // together (dedup only collapses the *same* doc referenced twice).
    expect(data.nodes.filter((n) => n.kind === "reference")).toHaveLength(2);
  });

  it("de-duplicates a cross-project edge even when two entities produce it in opposite directions", async () => {
    // "Forward"'s docs connect app then other → cross-edge project:app -> project:other.
    // "Backward"'s docs connect other then app (same two docs, opposite order)
    // → cross-edge project:other -> project:app, the reverse pair. Only one
    // of the two should survive edge de-duplication.
    const client = clientWith({
      listProjects: vi.fn(async () => ok({ projects: [{ name: "app" }, { name: "other" }] })),
      readGraph: vi.fn(async () => ok({
        fragments: [
          { name: "Forward", docs: ["app/x.md", "other/y.md"] },
          { name: "Backward", docs: ["other/y.md", "app/x.md"] },
        ],
      })),
    });
    const data = await loadGraphData(client);
    const crossEdges = data.edges.filter(
      (e) =>
        (e.source === "project:app" && e.target === "project:other") ||
        (e.source === "project:other" && e.target === "project:app"),
    );
    expect(crossEdges).toHaveLength(1);
  });
});

describe("showGraphWebview: webview <-> extension message protocol", () => {
  // A hand-rolled fake WebviewPanel: captures the single onDidReceiveMessage
  // handler showGraphWebview registers so tests can drive it directly with
  // synthetic messages, and records every postMessage call it makes back.
  function fakePanel() {
    let receive: ((msg: unknown) => unknown) | undefined;
    const panel = {
      iconPath: undefined as unknown,
      webview: {
        html: "",
        cspSource: "",
        onDidReceiveMessage: vi.fn((cb: (msg: unknown) => unknown) => {
          receive = cb;
          return { dispose: vi.fn() };
        }),
        postMessage: vi.fn(async () => true),
      },
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
      reveal: vi.fn(),
    };
    return {
      panel,
      async send(msg: unknown): Promise<void> {
        if (!receive) throw new Error("onDidReceiveMessage was never registered — did showGraphWebview's initial load fail?");
        await receive(msg);
      },
    };
  }

  function extensionContextStub() {
    return { extensionUri: {}, extensionPath: "/ext" } as unknown as vscode.ExtensionContext;
  }

  async function setup(client: PhrenClient) {
    const { panel, send } = fakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);
    await showGraphWebview(client, extensionContextStub());
    return { panel, send };
  }

  function postedTypes(panel: ReturnType<typeof fakePanel>["panel"]): unknown[] {
    return vi.mocked(panel.webview.postMessage).mock.calls.map(([m]) => (m as { type?: string }).type);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a mutating command carrying an invalid (path-traversal-shaped) project name before ever confirming or calling the client", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);

    await send({ command: "deleteFinding", projectName: "../etc", text: "x" });

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(client.removeFinding).not.toHaveBeenCalled();
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it("ignores messages with no recognized command, and non-object messages, without throwing or touching the client", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);

    await send({ command: "notARealCommand" });
    await send("just a string");
    await send(null);
    await send(42);

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("saveFindingEdit with a nodeId patches that node in place instead of doing a full refresh", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);

    await send({ command: "saveFindingEdit", projectName: "app", oldText: "old", newText: "new", nodeId: "finding:app:f1" });

    expect(client.editFinding).toHaveBeenCalledWith("app", "old", "new");
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "nodeUpdated", id: "finding:app:f1", changes: { text: "new" } });
    expect(postedTypes(panel)).not.toContain("graphData");
  });

  it("saveFindingEdit without a nodeId falls back to a full graph refresh", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);

    await send({ command: "saveFindingEdit", projectName: "app", oldText: "old", newText: "new" });

    expect(postedTypes(panel)).toContain("graphData");
    expect(postedTypes(panel)).not.toContain("nodeUpdated");
  });

  it("saveFindingEdit shows an error and posts nothing when the client call fails", async () => {
    const client = fakeClient({ editFinding: vi.fn(async () => { throw new Error("locked"); }) });
    const { send, panel } = await setup(client);

    await send({ command: "saveFindingEdit", projectName: "app", oldText: "old", newText: "new", nodeId: "n1" });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update finding: locked");
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it("deleteFinding requires the modal confirmation to be exactly Delete", async () => {
    const client = fakeClient();
    const { send } = await setup(client);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);

    await send({ command: "deleteFinding", projectName: "app", text: "x", nodeId: "n1" });

    expect(client.removeFinding).not.toHaveBeenCalled();
  });

  it("deleteFinding on confirmation removes the finding and posts a nodeRemoved message with an undo payload", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Delete");

    await send({ command: "deleteFinding", projectName: "app", text: "the finding", nodeId: "finding:app:f1" });

    expect(client.removeFinding).toHaveBeenCalledWith("app", "the finding");
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "nodeRemoved", id: "finding:app:f1",
      undo: { kind: "finding", projectName: "app", text: "the finding", label: "Finding deleted" },
    });
  });

  it("deleteBatch skips items with an invalid project name, still processes the rest, and reports a partial count", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Delete");

    await send({
      command: "deleteBatch",
      items: [
        { kind: "finding", projectName: "app", text: "keep me" },
        { kind: "finding", projectName: "../bad", text: "should be skipped" },
      ],
    });

    expect(client.removeFinding).toHaveBeenCalledTimes(1);
    expect(client.removeFinding).toHaveBeenCalledWith("app", "keep me");
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "batchRemoved",
      undo: { items: [{ kind: "finding", projectName: "app", text: "keep me", item: "" }], label: "Deleted 1 item" },
    });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("Deleted 1 of 2 items.");
  });

  it("mergeFindings removes both originals, adds the merged text, and offers an undo naming the exact originals", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Merge");

    await send({ command: "mergeFindings", projectName: "app", text1: "first", text2: "second" });

    expect(client.removeFinding).toHaveBeenNthCalledWith(1, "app", "first");
    expect(client.removeFinding).toHaveBeenNthCalledWith(2, "app", "second");
    expect(client.addFinding).toHaveBeenCalledWith("app", "first\nsecond");
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "mergeDone", undo: { projectName: "app", merged: "first\nsecond", originals: ["first", "second"] },
    });
  });

  it("undoMerge requires exactly 2 originals — a malformed undo payload is a silent no-op", async () => {
    const client = fakeClient();
    const { send } = await setup(client);

    await send({ command: "undoMerge", projectName: "app", merged: "first\nsecond", originals: ["only one"] });

    expect(client.removeFinding).not.toHaveBeenCalled();
    expect(client.addFinding).not.toHaveBeenCalled();
  });

  it("requestRefresh posts a fresh graphData payload", async () => {
    const client = fakeClient();
    const { send, panel } = await setup(client);

    await send({ command: "requestRefresh" });

    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "graphData", payload: expect.any(Object) });
  });
});
