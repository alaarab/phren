import { writeStoreRegistry, registeredStoreIdentity, registerStoreIdentity, attachedStoresFilePath } from "../store-registry.js";
/** Prepared for the consolidated RC. Do not run during build-only development. */
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addTask, readTasks, updateTask, completeTask, tidyDoneTasks, workNextTask, claimTask, parseTaskContent } from "./tasks.js";
import { taskReadiness, taskIdentity, filterTaskDoc, taskCounts } from "./task-contract.js";
import { getTaskRoute, getTaskDirectoryRoute, updateTaskRoute, createTaskRoute, saveTaskRoute, launchTaskRoute } from "../bridge/task-routes.js";
import { mergeTasksByBid } from "../sync/task-merge.js";
import { enableTaskFormat } from "./task-format.js";

import { launchSession } from "../bridge/server-launch.js";
import { writeProjectConfig } from "../project-config.js";
vi.mock("../bridge/server-launch.js", () => ({ launchSession: vi.fn() }));

let base: string, cleanup: () => void;
beforeEach(() => {
  vi.mocked(launchSession).mockReset();
  ({ path: base, cleanup } = makeTempDir("task-contract-"));
  grantAdmin(base);
  writeStoreRegistry(base, { version: 1, stores: [{ id: "11111111", name: "Personal", path: base, role: "primary", sync: "managed-git" }] });
  enableTaskFormat(base, true);
  for (const project of ["app", "core"]) fs.mkdirSync(path.join(base, project));
});
afterEach(() => cleanup());
function add(project: string, text: string) {
  const result = addTask(base, project, text);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function doc(project: string) {
  const result = readTasks(base, project);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function item(project: string, id: string) { const d = doc(project); return [...d.items.Active, ...d.items.Queue, ...d.items.Done].find(t => t.stableId === id)!; }
function identity(project: string, id: string) { return taskIdentity(base, doc(project), item(project, id))!; }

describe("task responsibility and prerequisites (RC source, unrun)", () => {
  it("reports activation permissions and blocks Hook metadata writes until owner acknowledgement", async () => {
    const a = add("core", "Keep legacy writer compatibility"), file = path.join(base, "core/tasks.md");
    fs.unlinkSync(path.join(base, ".config/task-format.json"));
    const before = fs.readFileSync(file, "utf8");
    const url = new URL("http://phren.local/v1/tasks?storeId=11111111&project=core");
    const ref = { storeId: "11111111", project: "core", stableId: a.stableId! };
    expect(getTaskRoute(base, url).metadataWritable).toBe(false);
    expect((await getTaskDirectoryRoute(base)).stores[0].metadataWritable).toBe(false);
    expect(() => updateTaskRoute(base, { ...ref, updates: { responsibility: "human" } })).toThrow(/not enabled/);
    expect(updateTask(base, "core", a.stableId!, { responsibility: "human" }).ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(() => enableTaskFormat(base, false)).toThrow();
    enableTaskFormat(base, true);
    const updated = updateTaskRoute(base, { ...ref, updates: { responsibility: "human" } });
    expect(updated.metadataWritable).toBe(true);
    expect(updated.items.Queue[0].responsibility).toBe("human");
  });
  it("creates Human tasks atomically and refuses conflicting retry identities", () => {
    const request = { storeId: "11111111", project: "core", stableId: "aaaaaaaa", text: "Owner signs in", responsibility: "human" };
    const created = createTaskRoute(base, request);
    expect(created.items.Queue[0]).toMatchObject({ stableId: "aaaaaaaa", responsibility: "human", readiness: "waiting-on-human" });
    expect(workNextTask(base, "core").ok).toBe(false);
    const file = path.join(base, "core/tasks.md"), before = fs.readFileSync(file, "utf8");
    expect(createTaskRoute(base, request).items.Queue).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(() => createTaskRoute(base, { ...request, text: "Different work" })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it("saves text/context/metadata together and refuses stale documents without losing any fields", () => {
    const created = createTaskRoute(base, { storeId: "11111111", project: "core", stableId: "aaaaaaaa", text: "Original", responsibility: "agent" });
    const ref = { storeId: "11111111", project: "core", stableId: "aaaaaaaa" };
    const updated = saveTaskRoute(base, { ...ref, expectedRevision: created.revision,
      updates: { text: "Reviewed title", context: "Owner context", responsibility: "human" } });
    expect(updated.items.Queue[0]).toMatchObject({ line: "Reviewed title", context: "Owner context", responsibility: "human", stableId: "aaaaaaaa" });
    const file = path.join(base, "core/tasks.md"), saved = fs.readFileSync(file, "utf8");
    expect(() => saveTaskRoute(base, { ...ref, expectedRevision: created.revision, updates: { text: "Stale overwrite", context: "Lost context" } })).toThrow(/revision changed/);
    expect(() => saveTaskRoute(base, { ...ref, expectedRevision: updated.revision, updates: { text: "Partial write", dependencies: [{ ...ref, stableId: "bbbbbbbb" }] } })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
    const cleared = saveTaskRoute(base, { ...ref, expectedRevision: updated.revision, updates: { context: "" } });
    expect(cleared.items.Queue[0].context).toBeUndefined();
    expect(cleared.items.Queue[0].line).toBe("Reviewed title");
    expect(cleared.items.Queue[0].responsibility).toBe("human");
    // Even an external formatting-only edit invalidates the document token.
    fs.appendFileSync(file, "\n");
    expect(() => saveTaskRoute(base, { ...ref, expectedRevision: cleared.revision, updates: { text: "Stale bytes" } })).toThrow(/revision changed/);
  });
  it("launches only a reserved saved task and retains the claim across a lost launch reply", async () => {
    const ref = { storeId: "11111111", project: "core", stableId: "aaaaaaaa" };
    const url = new URL("http://phren.local/v1/tasks?storeId=11111111&project=core");
    const created = createTaskRoute(base, { ...ref, text: "Saved work", responsibility: "human" });
    writeProjectConfig(base, "core", { sourcePath: base });
    await expect(launchTaskRoute(base, "default", { ...ref, expectedRevision: created.revision, kind: "claude" })).rejects.toThrow(/not eligible/);
    expect(launchSession).not.toHaveBeenCalled();
    const ready = saveTaskRoute(base, { ...ref, expectedRevision: created.revision, updates: { responsibility: "agent", context: "Exact saved context" } });
    await expect(launchTaskRoute(base, "default", { ...ref, expectedRevision: created.revision, kind: "claude" })).rejects.toThrow(/revision changed/);
    await expect(launchTaskRoute(base, "default", { ...ref, expectedRevision: ready.revision, kind: "claude", brief: { text: "Injected work" } })).rejects.toThrow();
    expect(launchSession).not.toHaveBeenCalled();
    vi.mocked(launchSession).mockImplementationOnce(async (_server, data) => {
      const held = item("core", "aaaaaaaa");
      expect(held.section).toBe("Active");
      expect(held.claim?.session).toBe(`task-launch:${data.launchId}`);
      expect(data.brief).toEqual({ id: data.launchId, text: "Work on task 11111111/core/aaaaaaaa.\n\nSaved work\n\nContext: Exact saved context" });
      throw new Error("Lost reply after worker creation");
    });
    await expect(launchTaskRoute(base, "default", { ...ref, expectedRevision: ready.revision, kind: "claude" })).rejects.toMatchObject({ details: { code: "task-launch-uncertain", claimPreserved: true } });
    const refreshed = getTaskRoute(base, url);
    await expect(launchTaskRoute(base, "default", { ...ref, expectedRevision: refreshed.revision, kind: "claude" })).rejects.toThrow(/already has a claim/);
    expect(launchSession).toHaveBeenCalledTimes(1);
    expect(item("core", "aaaaaaaa").claim).toBeDefined();
  });
  it("requires explicit portable identity registration without changing legacy task bytes", async () => {
    const a = add("core", "Legacy store"), file = path.join(base, "core/tasks.md");
    const before = fs.readFileSync(file, "utf8");
    fs.unlinkSync(path.join(base, "stores.yaml"));
    expect(taskIdentity(base, doc("core"), item("core", a.stableId!))).toBeUndefined();
    expect(registeredStoreIdentity(base)).toBeUndefined();
    expect((await getTaskDirectoryRoute(base)).stores[0]).toMatchObject({ id: null, identityReady: false });
    expect(fs.existsSync(path.join(base, "stores.yaml"))).toBe(false);
    const id = registerStoreIdentity(base);
    expect(registerStoreIdentity(base)).toBe(id);
    expect(taskIdentity(base, doc("core"), item("core", a.stableId!))?.storeId).toBe(id);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  // Literal persisted fixtures guard the old parser's stop-at-Task failure.
  // Exercise the real whole-file writer; no copied old parser or test-only seam.
  it.each([
    { name: "legacy", records: [] as string[], opaque: false },
    { name: "v1", records: ['{"version":1,"responsibility":"human","dependencies":[{"storeId":"11111111","project":"app","stableId":"bbbbbbbb"}],"history":[{"at":"2026-10-01T00:00:00Z","change":"Owner assigned prerequisite"}]}'], opaque: false },
    { name: "future", records: ['{"version":2,"future":true}'], opaque: true },
    { name: "blank", records: [""], opaque: true },
    { name: "blank-duplicate", records: ["", '{"version":1,"responsibility":"agent","dependencies":[],"history":[]}'], opaque: true },
    { name: "duplicate", records: ['{"version":1,"responsibility":"human","dependencies":[],"history":[]}', '{"version":2,"future":true}'], opaque: true },
  ])("preserves $name metadata and later context/claim during ordinary rewrites before activation", ({ name, records, opaque }) => {
    const file = path.join(base, "core/tasks.md");
    fs.unlinkSync(path.join(base, ".config/task-format.json"));
    const future = name === "blank" ? "  Future: preserve before metadata\n" : "";
    const continuations = records.map(raw => `  Task: ${raw}\n`).join("");
    fs.writeFileSync(file, `# core tasks\n\n## Queue\n\n- [ ] Preserve me <!-- bid:aaaaaaaa created:2026-10-01T00:00:00Z -->\n${future}${continuations}  Context: Preserve owner context\n  Claimed: Desk 2026-10-02T00:00:00Z session:existing-worker\n  GitHub: #42 https://github.com/alaarab/phren/issues/42\n`);
    expect(updateTask(base, "core", "bid:aaaaaaaa", { text: "Renamed", section: "Active" }).ok).toBe(true);
    const retained = fs.readFileSync(file, "utf8");
    expect(retained).toContain("  Context: Preserve owner context\n");
    expect(retained).toContain("  Claimed: Desk 2026-10-02T00:00:00Z session:existing-worker\n");
    if (future) expect(retained).toContain(future);
    const current = item("core", "aaaaaaaa");
    expect(current).toMatchObject({ line: "Renamed", stableId: "aaaaaaaa", createdAt: "2026-10-01T00:00:00Z", section: "Active", context: "Preserve owner context", githubIssue: 42, githubUrl: "https://github.com/alaarab/phren/issues/42", claim: { computer: "Desk", at: "2026-10-02T00:00:00Z", session: "existing-worker" } });
    if (name === "legacy") expect(retained).not.toContain("  Task:");
    if (name === "v1") {
      expect(current.responsibility).toBe("human");
      expect(current.dependencies).toEqual([{ storeId: "11111111", project: "app", stableId: "bbbbbbbb" }]);
      expect(current.history?.[0]).toEqual({ at: "2026-10-01T00:00:00Z", change: "Owner assigned prerequisite" });
      expect(current.history).toHaveLength(2);
    }
    if (opaque) {
      expect(retained.split("\n").filter(line => line.startsWith("  Task:"))).toEqual(records.map(raw => "  Task: " + raw));
      expect(taskReadiness(base, doc("core"), current).readiness).toBe("waiting-on-task");
      expect(workNextTask(base, "core").ok).toBe(false);
      // Once enabled, rejection must come from opaque metadata, not activation.
      enableTaskFormat(base, true);
      const result = updateTask(base, "core", "bid:aaaaaaaa", { responsibility: "agent" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid or from a newer version/);
      expect(fs.readFileSync(file, "utf8")).toBe(retained);
    }
  });
  it("retains opaque root/dependency/history extensions across ordinary writes and sync", () => {
    const a = add("core", "Unknown"), source = fs.readFileSync(path.join(base, "core/tasks.md"), "utf8");
    const metadata = { version: 1, responsibility: "human", dependencies: [], history: [] };
    for (const extended of [{ ...metadata, responsibility: ["human"] }, { ...metadata, future: true }, { ...metadata, dependencies: [{ storeId: "12345678", project: "core", stableId: "87654321", future: true }] }, { ...metadata, history: [{ at: "now", change: "owner action", future: true }] }]) {
      const line = `    Task:   ${JSON.stringify(extended)}  `, theirs = source.replace(/(<!-- bid:[^\n]+-->)/, `$1\n${line}`);
      fs.writeFileSync(path.join(base, "core/tasks.md"), theirs);
      expect(updateTask(base, "core", a.stableId!, { text: "Keep future bytes", section: "Active" }).ok).toBe(true);
      const retained = fs.readFileSync(path.join(base, "core/tasks.md"), "utf8");
      expect(retained.split("\n")).toContain(line);
      expect(taskReadiness(base, doc("core"), item("core", a.stableId!)).readiness).toBe("waiting-on-task");
      expect(claimTask(base, "core", a.stableId!, { computer: "Desk", at: "2026-10-03T00:00:00Z" }).ok).toBe(false);
      expect(mergeTasksByBid(source, source, retained).split("\n")).toContain(line);
    }
  });
  it("never satisfies a prerequisite from a title reference or duplicate archived stable IDs", () => {
    const a = add("core", "Dependent"), ref = { ...identity("core", a.stableId!), stableId: "abcdef12" };
    const file = path.join(base, ".config/task-archive/core.md"); fs.mkdirSync(path.dirname(file), { recursive: true });
    const dependent = item("core", a.stableId!); dependent.dependencies = [ref]; const current = doc("core");
    fs.writeFileSync(file, "- [x] Mentions bid:abcdef12 only in title <!-- bid:11111111 -->\n");
    expect(taskReadiness(base, current, dependent).prerequisites[0].missing).toBe(true);
    fs.writeFileSync(file, "- [x] First <!-- bid:abcdef12 -->\n- [x] Second <!-- bid:abcdef12 -->\n");
    expect(taskReadiness(base, current, dependent).prerequisites[0].missing).toBe(true);
    fs.writeFileSync(file, "- [x] First <!-- bid:abcdef12 -->\n- [ ] Reopened duplicate <!-- bid:abcdef12 -->\n");
    expect(taskReadiness(base, current, dependent).prerequisites[0].missing).toBe(true);
    fs.writeFileSync(file, "- [x] Conflicting comments <!-- bid:abcdef12 --> <!-- bid:11111111 -->\n");
    expect(taskReadiness(base, current, dependent).prerequisites[0].missing).toBe(true);
    fs.writeFileSync(file, "- [ ] Unfinished archived record <!-- bid:abcdef12 -->\n");
    expect(taskReadiness(base, current, dependent).prerequisites[0].missing).toBe(true);
  });
  it("never falls back from a missing stable identity to a title or claims duplicated live identities", () => {
    const a = add("core", "Mentions bid:abcdef12 in its title"), file = path.join(base, "core/tasks.md");
    const before = fs.readFileSync(file, "utf8");
    expect(updateTaskRoute.bind(null, base, { storeId: "11111111", project: "core", stableId: "abcdef12", updates: { section: "Done" } })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    fs.writeFileSync(file, `${before}\n- [ ] Duplicate <!-- bid:${a.stableId} -->\n`);
    expect(workNextTask(base, "core").ok).toBe(false);
    expect(updateTask(base, "core", "Q1", { text: "Must retain the duplicated IDs" }).ok).toBe(false);
    expect(taskIdentity(base, doc("core"), item("core", a.stableId!))).toBeUndefined();
    expect(() => mergeTasksByBid(before, before, fs.readFileSync(file, "utf8"))).toThrow(/unique/);
  });
  it("defaults legacy tasks to agent without writing or relabeling them", () => {
    const file = path.join(base, "core/tasks.md"), source = "# tasks\n\n## Queue\n\n- [ ] Legacy\n";
    fs.writeFileSync(file, source);
    const d = doc("core");
    expect(taskReadiness(base, d, d.items.Queue[0])).toMatchObject({ responsibility: "agent", readiness: "ready" });
    expect(fs.readFileSync(file, "utf8")).toBe(source);
  });
  it("reassigns and moves the same stable task without losing context, creation or history", () => {
    const a = add("core", "Keep identity");
    expect(claimTask(base, "core", a.stableId!, { computer: "Desk", at: "2026-10-03T00:00:00Z" }).ok).toBe(true);
    expect(updateTask(base, "core", a.stableId!, { responsibility: "human", context: "Owner account action", github_issue: 47, section: "Active" }).ok).toBe(true);
    expect(updateTask(base, "core", a.stableId!, { responsibility: "agent", section: "Queue" }).ok).toBe(true);
    const restored = item("core", a.stableId!);
    expect(restored).toMatchObject({ stableId: a.stableId, createdAt: a.createdAt, context: "Owner account action", githubIssue: 47, responsibility: "agent", section: "Queue", claim: undefined });
    expect(restored.history).toHaveLength(2);
    expect(restored.history![0].change).toContain("agent -> human");
    expect(restored.history![0].change).toContain("released claim by Desk");
    expect(restored.history![1].change).toContain("human -> agent");
  });
  it("shows cross-project prerequisite titles and resumes after completion and archival", () => {
    const owner = add("app", "Sign into account"), dependent = add("core", "Use account");
    expect(updateTask(base, "app", owner.stableId!, { responsibility: "human" }).ok).toBe(true);
    expect(updateTask(base, "core", dependent.stableId!, { dependencies: [identity("app", owner.stableId!)] }).ok).toBe(true);
    expect(taskReadiness(base, doc("core"), item("core", dependent.stableId!))).toMatchObject({ readiness: "waiting-on-human", prerequisites: [{ title: "Sign into account" }] });
    expect(completeTask(base, "app", owner.stableId!).ok).toBe(true);
    expect(tidyDoneTasks(base, "app", 0).ok).toBe(true);
    expect(taskReadiness(base, doc("core"), item("core", dependent.stableId!)).readiness).toBe("ready");
  });
  it("refuses cycles/self-links/missing references and preserves source on rejection", () => {
    const a = add("core", "A"), b = add("app", "B");
    const ai = identity("core", a.stableId!), bi = identity("app", b.stableId!);
    expect(updateTask(base, "core", a.stableId!, { dependencies: [ai] }).ok).toBe(false);
    expect(updateTask(base, "core", a.stableId!, { dependencies: [bi] }).ok).toBe(true);
    const before = fs.readFileSync(path.join(base, "app/tasks.md"), "utf8");
    expect(updateTask(base, "app", b.stableId!, { dependencies: [ai] }).ok).toBe(false);
    expect(updateTask(base, "app", b.stableId!, { dependencies: [{ ...ai, stableId: "ffffffff" }] }).ok).toBe(false);
    expect(fs.readFileSync(path.join(base, "app/tasks.md"), "utf8")).toBe(before);
  });
  it("next/claim skip human and blocked tasks, while explicit completion remains available", () => {
    const human = add("core", "Owner action"), blocked = add("core", "Blocked"), ready = add("core", "Ready");
    updateTask(base, "core", human.stableId!, { responsibility: "human" });
    updateTask(base, "core", blocked.stableId!, { dependencies: [identity("core", human.stableId!)] });
    expect(claimTask(base, "core", human.stableId!, { computer: "Desk", at: new Date().toISOString() }).ok).toBe(false);
    expect(claimTask(base, "core", blocked.stableId!, { computer: "Desk", at: new Date().toISOString() }).ok).toBe(false);
    expect(workNextTask(base, "core").ok).toBe(true);
    expect(doc("core").items.Active[0].stableId).toBe(ready.stableId);
    expect(completeTask(base, "core", human.stableId!).ok).toBe(true);
  });
  it("Hook uses the same stable identity and refuses arbitrary stores", () => {
    const a = add("core", "Hook action"), ref = identity("core", a.stableId!);
    const value = updateTaskRoute(base, { ...ref, updates: { responsibility: "human" } });
    expect(value.items.Queue[0]).toMatchObject({ stableId: a.stableId, responsibility: "human", readiness: "waiting-on-human" });
    expect(() => getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=ffffffff&project=core"))).toThrow();
  });
  it("sync retains independent lane and prerequisite edits with both histories", () => {
    const bullet = "# core\n\n## Queue\n\n- [ ] A <!-- bid:aaaaaaaa -->\n";
    const contract = (responsibility: string, dependencies: unknown[], change: string) => `  Task: ${JSON.stringify({ version: 1, responsibility, dependencies, history: [{ at: "2026-10-03T00:00:00Z", change }] })}\n`;
    const merged = mergeTasksByBid(bullet, bullet + contract("human", [], "lane"), bullet + contract("agent", [{ storeId: "bbbbbbbb", project: "app", stableId: "cccccccc" }], "dependency"));
    expect(merged).toContain('"responsibility":"human"');
    expect(merged).toContain('"stableId":"cccccccc"');
    expect(merged).toContain('"change":"lane"');
    expect(merged).toContain('"change":"dependency"');
  });
  it("releases a racing claim when independent sync edits merge to human responsibility", () => {
    const bullet = "# core\n\n## Queue\n\n- [ ] A <!-- bid:aaaaaaaa -->\n";
    const ours = bullet + '  Task: {"version":1,"responsibility":"human","dependencies":[],"history":[{"at":"2026-10-03T00:00:00Z","change":"agent -> human"}]}\n';
    const theirs = bullet.replace("## Queue", "## Active") + "  Claimed: Desk 2026-10-03T00:01:00Z\n";
    const merged = mergeTasksByBid(bullet, ours, theirs), parsed = parseTaskContent("core", path.join(base, "core/tasks.md"), merged);
    expect(parsed.items.Active[0]).toMatchObject({ responsibility: "human", claim: undefined });
    expect(parsed.items.Active[0].history?.some(h => h.change.includes("released claim by Desk"))).toBe(true);
    expect(taskReadiness(base, parsed, parsed.items.Active[0]).readiness).toBe("waiting-on-human");
  });
  it("keeps directory discovery read-only for old registries and refuses partial identity evidence", async () => {
    const other = path.join(base, "secondary"); fs.mkdirSync(path.join(other, "app"), { recursive: true }); grantAdmin(other);
    writeStoreRegistry(other, { version: 1, stores: [{ id: "22222222", name: "Team", path: other, role: "primary", sync: "managed-git" }] });
    const synced = `version: 1\nstores:\n  - id: '11111111'\n    name: Personal\n    path: ${JSON.stringify(base)}\n    role: primary\n  - id: '99999999'\n    name: Team\n    path: ${JSON.stringify(other)}\n    role: readonly\n    projects: [app]\n`;
    fs.writeFileSync(path.join(base, "stores.yaml"), synced);
    fs.unlinkSync(attachedStoresFilePath(base));
    const directory = await getTaskDirectoryRoute(base);
    expect(directory.stores.find(s => s.name === "Team")).toMatchObject({ id: "22222222", role: "readonly", projects: ["app"], metadataWritable: false });
    expect(fs.existsSync(attachedStoresFilePath(base))).toBe(false);
    expect(fs.readFileSync(path.join(base, "stores.yaml"), "utf8")).toBe(synced);
    expect(JSON.stringify(directory)).not.toContain(base);
    expect(() => updateTaskRoute(base, { storeId: "22222222", project: "app", stableId: "aaaaaaaa", updates: { section: "Done" } })).toThrow(/read-only/);
    fs.writeFileSync(attachedStoresFilePath(base), "version: 1\nstores:\n  - id: malformed\n");
    expect((await getTaskDirectoryRoute(base)).stores).toEqual([]);
    expect(() => getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=11111111&project=core"))).toThrow(/ambiguous/);
  });
  it("rejects duplicate canonical stores and non-hex registries rather than guessing identity", async () => {
    const other = path.join(base, "secondary"); fs.mkdirSync(path.join(other, "app"), { recursive: true }); grantAdmin(other);
    writeStoreRegistry(other, { version: 1, stores: [{ id: "11111111", name: "Team", path: other, role: "primary", sync: "managed-git" }] });
    writeStoreRegistry(base, { version: 1, stores: [
      { id: "11111111", name: "Personal", path: base, role: "primary", sync: "managed-git" },
      { id: "99999999", name: "Team", path: other, role: "team", sync: "managed-git", projects: ["app"] },
    ] });
    const directory = await getTaskDirectoryRoute(base);
    const duplicateStores = directory.stores.filter(s => s.id === "11111111");
    expect(duplicateStores).toHaveLength(2);
    expect(duplicateStores.every(s => s.ambiguous && !s.identityReady && !s.metadataWritable)).toBe(true);
    expect(() => getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=11111111&project=core"))).toThrow(/ambiguous/);
    writeStoreRegistry(other, { version: 1, stores: [{ id: "not-hex-id", name: "Team", path: other, role: "primary", sync: "managed-git" }] });
    expect(registeredStoreIdentity(other)).toBeUndefined();
    expect(() => registerStoreIdentity(other)).toThrow(/immutable ID/);
    expect((await getTaskDirectoryRoute(base)).stores.find(s => s.name === "Team")).toMatchObject({ id: null, identityReady: false });
  });
  it("never broadens a malformed subscription and retains only the attached project's access", async () => {
    const other = path.join(base, "secondary"); fs.mkdirSync(path.join(other, "app"), { recursive: true }); fs.mkdirSync(path.join(other, "private")); grantAdmin(other);
    writeStoreRegistry(other, { version: 1, stores: [{ id: "22222222", name: "Team", path: other, role: "primary", sync: "managed-git" }] });
    writeStoreRegistry(base, { version: 1, stores: [
      { id: "11111111", name: "Personal", path: base, role: "primary", sync: "managed-git" },
      { id: "99999999", name: "Team", path: other, role: "team", sync: "managed-git", projects: ["app"] },
    ] });
    expect((await getTaskDirectoryRoute(base)).stores.find(s => s.name === "Team")?.projects).toEqual(["app"]);
    expect(() => getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=22222222&project=private"))).toThrow(/not in/);
    const registry = fs.readFileSync(attachedStoresFilePath(base), "utf8");
    for (const projects of ["[42]", "[app, '../private']", "app"]) {
      fs.writeFileSync(attachedStoresFilePath(base), registry.replace(/projects:\n\s+- app/, `projects: ${projects}`));
      expect((await getTaskDirectoryRoute(base)).stores).toEqual([]);
    }
  });
  it("filters a lane without making excluded prerequisites disappear", () => {
    const human = add("core", "Owner"), agent = add("core", "Agent");
    updateTask(base, "core", human.stableId!, { responsibility: "human" });
    updateTask(base, "core", agent.stableId!, { dependencies: [identity("core", human.stableId!)] });
    const d = doc("core");
    expect(filterTaskDoc(base, d, { responsibility: "agent", readiness: "waiting-on-human" }).items.Queue.map(t => t.stableId)).toEqual([agent.stableId]);
    expect(taskCounts(base, d)).toMatchObject({ human: 1, agentReady: 0, agentWaitingOnHuman: 1 });
    const ref = identity("core", agent.stableId!);
    const route = getTaskRoute(base, new URL(`http://phren.local/v1/tasks?storeId=${ref.storeId}&project=core&responsibility=agent`));
    expect(route.items.Queue[0].prerequisites[0].title).toBe("Owner");
  });
  it("resolves a cross-store prerequisite by immutable identity for next/claim", async () => {
    const other = path.join(base, "secondary"); fs.mkdirSync(path.join(other, "app"), { recursive: true }); grantAdmin(other);
    writeStoreRegistry(base, { version: 1, stores: [
      { id: "11111111", name: "Personal", path: base, role: "primary", sync: "managed-git" },
      { id: "99999999", name: "Team", path: other, role: "team", sync: "managed-git", projects: ["app"] },
    ] });
    writeStoreRegistry(other, { version: 1, stores: [{ id: "22222222", name: "Team", path: other, role: "primary", sync: "managed-git" }] });
    enableTaskFormat(other, true);
    const prerequisite = add("core", "Shared prerequisite"), dependent = addTask(other, "app", "Dependent");
    if (!dependent.ok) throw new Error(dependent.error);
    expect((await getTaskDirectoryRoute(base)).stores.find(s => s.name === "Team")).toMatchObject({ id: "22222222", identityReady: true });
    const taskResult = getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=22222222&project=app"));
    expect(taskResult.items.Queue[0].identity?.storeId).toBe("22222222");
    expect(() => getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=99999999&project=app"))).toThrow();
    expect(updateTask(other, "app", dependent.data.stableId!, { dependencies: [identity("core", prerequisite.stableId!)] }, base).ok).toBe(true);
    expect(workNextTask(other, "app", base).ok).toBe(false);
    completeTask(base, "core", prerequisite.stableId!);
    expect(claimTask(other, "app", dependent.data.stableId!, { computer: "Desk", at: new Date().toISOString() }, { graphRoot: base }).ok).toBe(true);
  });

});
