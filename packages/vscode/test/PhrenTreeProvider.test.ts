import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { PhrenTreeProvider } from "../src/providers/PhrenTreeProvider";
import { deviceContext, fakeClient, ok } from "./test-helpers";

// See tree-data.test.ts for why this is mocked: readDeviceContext reads
// machine identity / ~/.phren-context.md from the real OS home directory
// regardless of storePath, which would make getParent's project-routing
// tests dependent on whatever real phren state exists on the machine
// running them.
vi.mock("../src/profileConfig", () => ({
  readDeviceContext: vi.fn(() => ({ profile: "", activeProjects: new Set<string>(), machine: "test-machine", lastSync: "" })),
}));
import { readDeviceContext } from "../src/profileConfig";

const STORE_PATH = "/tmp/does-not-need-to-exist";

beforeEach(() => {
  vi.mocked(readDeviceContext).mockReturnValue(deviceContext());
  vscode.workspace.workspaceFolders = undefined;
});

describe("PhrenTreeProvider.getChildren: delegates to TreeDataSource", () => {
  it("with no element, returns the root sections", async () => {
    const provider = new PhrenTreeProvider(fakeClient(), STORE_PATH);
    const children = await provider.getChildren(undefined);
    expect(children.map((c) => (c.kind === "rootSection" ? c.section : c.kind))).toContain("projects");
  });

  it("a project node expands to its 8 fixed categories", async () => {
    const provider = new PhrenTreeProvider(fakeClient(), STORE_PATH);
    const children = await provider.getChildren({ kind: "project", projectName: "app" });
    expect(children.map((c) => (c.kind === "category" ? c.category : undefined))).toEqual([
      "findings", "notes", "truths", "sessions", "task", "queue", "hooks", "reference",
    ]);
  });

  it("a findings category passes the provider's current date filter through to TreeDataSource", async () => {
    const getFindings = vi.fn(async () => ok({
      findings: [
        { id: "1", text: "in range", date: "2026-01-15" },
        { id: "2", text: "out of range", date: "2026-02-15" },
      ],
    }));
    const provider = new PhrenTreeProvider(fakeClient({ getFindings }), STORE_PATH);
    provider.setDateFilter({ from: "2026-01-01", to: "2026-01-31", label: "January" });

    const children = await provider.getChildren({ kind: "category", projectName: "app", category: "findings" });

    expect(children).toEqual([{ kind: "findingDateGroup", projectName: "app", date: "2026-01-15", count: 1 }]);
  });

  it("a globalTaskSectionGroup delegates to the matching section", async () => {
    const getAllTasks = vi.fn(async () => ok({
      projects: [{ project: "app", items: { Active: [{ id: "1", line: "a", pinned: true }] } }],
    }));
    const provider = new PhrenTreeProvider(fakeClient({ getAllTasks }), STORE_PATH);
    const children = await provider.getChildren({ kind: "globalTaskSectionGroup", section: "Pinned", count: 1 });
    expect(children.map((c) => (c.kind === "task" ? c.id : undefined))).toEqual(["1"]);
  });
});

describe("PhrenTreeProvider.getTreeItem: delegates to buildTreeItem with the current date filter", () => {
  it("reflects the active date filter in a findings category label", () => {
    const provider = new PhrenTreeProvider(fakeClient(), STORE_PATH);
    provider.setDateFilter({ label: "Last 7 days" });
    const item = provider.getTreeItem({ kind: "category", projectName: "app", category: "findings" });
    expect(item.label).toBe("Findings [Last 7 days]");
  });
});

describe("PhrenTreeProvider.getParent: multi-hop navigation", () => {
  it("walks finding -> findingDateGroup -> category -> project", async () => {
    const provider = new PhrenTreeProvider(fakeClient(), STORE_PATH);
    const finding = { kind: "finding" as const, projectName: "app", id: "f1", date: "2026-01-01", text: "x" };

    const dateGroup = await provider.getParent(finding);
    expect(dateGroup).toEqual({ kind: "findingDateGroup", projectName: "app", date: "2026-01-01", count: 0 });

    const category = await provider.getParent(dateGroup!);
    expect(category).toEqual({ kind: "category", projectName: "app", category: "findings" });

    const project = await provider.getParent(category!);
    expect(project).toEqual({ kind: "project", projectName: "app" });
  });

  it("a project's parent is a storeGroup when the store spans more than one store", async () => {
    const client = fakeClient({
      listProjects: vi.fn(async () => ok({ projects: [{ name: "app", store: "personal" }, { name: "b", store: "team" }] })),
      storeList: vi.fn(async () => ok({ stores: [{ name: "personal", role: "primary" }, { name: "team", role: "team" }] })),
    });
    const provider = new PhrenTreeProvider(client, STORE_PATH);

    const parent = await provider.getParent({ kind: "project", projectName: "app" });

    expect(parent).toMatchObject({ kind: "storeGroup", storeName: "personal" });
  });

  it("a project's parent is a device/other projectGroup when single-store and the device context has active projects", async () => {
    vi.mocked(readDeviceContext).mockReturnValue(deviceContext({ activeProjects: new Set(["app"]) }));
    const client = fakeClient({ listProjects: vi.fn(async () => ok({ projects: [{ name: "app" }, { name: "b" }] })) });
    const provider = new PhrenTreeProvider(client, STORE_PATH);

    const deviceParent = await provider.getParent({ kind: "project", projectName: "app" });
    expect(deviceParent).toEqual({ kind: "projectGroup", group: "device", count: 0 });

    const otherParent = await provider.getParent({ kind: "project", projectName: "b" });
    expect(otherParent).toEqual({ kind: "projectGroup", group: "other", count: 0 });
  });

  it("a project's parent is the root projects section when single-store with no device grouping", async () => {
    const client = fakeClient({ listProjects: vi.fn(async () => ok({ projects: [{ name: "app" }] })) });
    const provider = new PhrenTreeProvider(client, STORE_PATH);

    const parent = await provider.getParent({ kind: "project", projectName: "app" });

    expect(parent).toEqual({ kind: "rootSection", section: "projects" });
  });

  it("a rootSection and a projectGroup/storeGroup have well-defined parents", async () => {
    const provider = new PhrenTreeProvider(fakeClient(), STORE_PATH);
    expect(await provider.getParent({ kind: "rootSection", section: "projects" })).toBeUndefined();
    expect(await provider.getParent({ kind: "projectGroup", group: "device", count: 1 })).toEqual({ kind: "rootSection", section: "projects" });
    expect(await provider.getParent({ kind: "storeGroup", storeName: "team", role: "team", count: 1 })).toEqual({ kind: "rootSection", section: "projects" });
  });
});

describe("PhrenTreeProvider: change notification and caching", () => {
  it("refresh() clears the cache and fires onDidChangeTreeData", async () => {
    const listProjects = vi.fn(async () => ok({ projects: [] }));
    const provider = new PhrenTreeProvider(fakeClient({ listProjects }), STORE_PATH);
    const changed = vi.fn();
    provider.onDidChangeTreeData(changed);

    await provider.getChildren({ kind: "rootSection", section: "projects" });
    expect(listProjects).toHaveBeenCalledTimes(1);

    await provider.getChildren({ kind: "rootSection", section: "projects" }); // cached, no extra call
    expect(listProjects).toHaveBeenCalledTimes(1);

    provider.refresh();
    expect(changed).toHaveBeenCalledTimes(1);

    await provider.getChildren({ kind: "rootSection", section: "projects" });
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("setHealthStatus only fires a change when the value actually changes", () => {
    const provider = new PhrenTreeProvider(fakeClient(), STORE_PATH);
    const changed = vi.fn();
    provider.onDidChangeTreeData(changed);

    provider.setHealthStatus(true);
    expect(changed).toHaveBeenCalledTimes(1);

    provider.setHealthStatus(true); // unchanged — should not re-fire
    expect(changed).toHaveBeenCalledTimes(1);

    provider.setHealthStatus(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("setDateFilter clears the cache so the next fetch reflects it, and getDateFilter round-trips", async () => {
    const getFindings = vi.fn(async () => ok({ findings: [] }));
    const provider = new PhrenTreeProvider(fakeClient({ getFindings }), STORE_PATH);

    await provider.getChildren({ kind: "category", projectName: "app", category: "findings" });
    expect(getFindings).toHaveBeenCalledTimes(1);
    expect(provider.getDateFilter()).toBeUndefined();

    provider.setDateFilter({ label: "Today", from: "2026-01-01", to: "2026-01-01" });
    expect(provider.getDateFilter()).toEqual({ label: "Today", from: "2026-01-01", to: "2026-01-01" });

    await provider.getChildren({ kind: "category", projectName: "app", category: "findings" });
    expect(getFindings).toHaveBeenCalledTimes(2); // cache was cleared, not reused across the filter change
  });
});
