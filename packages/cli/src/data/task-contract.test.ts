import { writeStoreRegistry, registeredStoreIdentity, registerStoreIdentity, attachedStoresFilePath } from "../store-registry.js";
/** Prepared for the consolidated RC. Do not run during build-only development. */
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addTask, readTasks, updateTask, completeTask, tidyDoneTasks, workNextTask, claimTask, parseTaskContent, saveTask, taskRevisionConflict } from "./tasks.js";
import { taskReadiness, taskIdentity, filterTaskDoc, taskCounts } from "./task-contract.js";
import { getTaskRoute, getTaskDirectoryRoute, updateTaskRoute, saveTaskRoute } from "../bridge/task-routes.js";
import { mergeTasksByBid } from "../sync/task-merge.js";
import { enableTaskFormat } from "./task-format.js";

let base: string, cleanup: () => void;
beforeEach(() => {
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
  // Literal persisted fixtures guard the old parser's stop-at-Task failure.
  // Exercise the real whole-file writer; no copied old parser or test-only seam.
  it.each([
    { name: "legacy", records: [] as string[], opaque: false },
    { name: "v1", records: ['{"version":1,"responsibility":"human","dependencies":[{"storeId":"11111111","project":"app","stableId":"bbbbbbbb"}],"history":[{"at":"2026-10-01T00:00:00Z","change":"Owner assigned prerequisite"}]}'], opaque: false },
    { name: "future", records: ['{"version":2,"future":true}'], opaque: true },
    { name: "blank", records: [""], opaque: true },
    { name: "duplicate", records: ['{"version":1,"responsibility":"human","dependencies":[],"history":[]}', '{"version":2,"future":true}'], opaque: true },
  ])("preserves $name metadata and later context/claim during ordinary rewrites before activation", ({ name, records, opaque }) => {
    const file = path.join(base, "core/tasks.md");
    fs.unlinkSync(path.join(base, ".config/task-format.json"));
    const continuations = records.map(raw => `  Task: ${raw}\n`).join("");
    fs.writeFileSync(file, `# core tasks\n\n## Queue\n\n- [ ] Preserve me <!-- bid:aaaaaaaa created:2026-10-01T00:00:00Z -->\n${continuations}  Context: Preserve owner context\n  Claimed: Desk 2026-10-02T00:00:00Z session:existing-worker\n  GitHub: #42 https://github.com/alaarab/phren/issues/42\n`);
    expect(updateTask(base, "core", "bid:aaaaaaaa", { text: "Renamed", section: "Active" }).ok).toBe(true);
    const retained = fs.readFileSync(file, "utf8");
    expect(retained).toContain("  Context: Preserve owner context\n");
    expect(retained).toContain("  Claimed: Desk 2026-10-02T00:00:00Z session:existing-worker\n");
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
      // Once enabled, rejection must come from opaque metadata, not activation.
      enableTaskFormat(base, true);
      const result = updateTask(base, "core", "bid:aaaaaaaa", { responsibility: "agent" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid or from a newer version/);
      expect(fs.readFileSync(file, "utf8")).toBe(retained);
    }
  });
  it("blocks new responsibility metadata until the owner acknowledges compatible writers", () => {
    const a = add("core", "Keep legacy writer compatibility"), file = path.join(base, "core/tasks.md");
    fs.unlinkSync(path.join(base, ".config/task-format.json"));
    const before = fs.readFileSync(file, "utf8");
    expect(getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=11111111&project=core"))).toMatchObject({
      metadataWritable: false, metadataWriteBlock: "compatible-writer-adoption-required",
      writerSafety: { activation: "disabled", legacyWritersFenced: false, requiresCoordinatedAdoption: true },
    });
    expect(updateTask(base, "core", a.stableId!, { responsibility: "human" }).ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(() => enableTaskFormat(base, false)).toThrow();
    enableTaskFormat(base, true);
    expect(updateTask(base, "core", a.stableId!, { responsibility: "human" }).ok).toBe(true);
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
  it("preserves blank and duplicate metadata records while blocking selection and reassignment", () => {
    const a = add("core", "Opaque"), file = path.join(base, "core/tasks.md");
    for (const records of [[""], ["", '{"version":1,"responsibility":"agent","dependencies":[],"history":[]}'], [JSON.stringify({ version: 1, responsibility: "human", dependencies: [], history: [] }), '{"version":2,"future":true}']]) {
      const body = `# core tasks\n\n## Queue\n\n- [ ] Opaque <!-- bid:${a.stableId} -->\n  Future: preserve this continuation\n${records.map(raw => "  Task: " + raw).join("\n")}\n  Context: Retain this context\n`;
      fs.writeFileSync(file, body);
      expect(taskReadiness(base, doc("core"), item("core", a.stableId!)).readiness).toBe("waiting-on-task");
      expect(updateTask(base, "core", a.stableId!, { responsibility: "agent" }).ok).toBe(false);
      expect(updateTask(base, "core", a.stableId!, { text: "Opaque renamed" }).ok).toBe(true);
      const retained = fs.readFileSync(file, "utf8"); for (const raw of records) expect(retained).toContain("  Task: " + raw);
      expect(retained).toContain("Context: Retain this context"); expect(workNextTask(base, "core").ok).toBe(false);
      expect(retained).toContain("  Future: preserve this continuation");
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
  it("preserves unsupported metadata and never dispatches it", () => {
    const a = add("core", "Future"), file = path.join(base, "core/tasks.md");
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, raw.replace(/(<!-- bid:[^\n]+-->)/, '$1\n  Task: {"version":2,"future":true}'));
    expect(updateTask(base, "core", a.stableId!, { text: "Future retained" }).ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain('Task: {"version":2,"future":true}');
    expect(workNextTask(base, "core").ok).toBe(false);
  });
  it("Hook keeps native metadata writes blocked despite a compatible-writer acknowledgement", () => {
    const a = add("core", "Hook action"), ref = identity("core", a.stableId!);
    const file = path.join(base, "core/tasks.md"), before = fs.readFileSync(file, "utf8");
    const value = getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=11111111&project=core"));
    expect(value).toMatchObject({ saveWritable: false, metadataWritable: false, metadataWriteBlock: "legacy-writer-fence-required",
      writerSafety: { activation: "owner-acknowledged", legacyWritersFenced: false, requiresCoordinatedAdoption: true } });
    expect(() => updateTaskRoute(base, { ...ref, updates: { responsibility: "human" } })).toThrow(/adoption fence/);
    expect(() => updateTaskRoute(base, { ...ref, updates: { dependencies: [] } })).toThrow(/adoption fence/);
    expect(() => saveTaskRoute(base, { storeId: ref.storeId, project: ref.project, expectedRevision: value.revision,
      mode: "create", task: { text: "Owner only", responsibility: "human" } })).toThrow(/adoption fence/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(updateTaskRoute(base, { ...ref, updates: { section: "Active" } }).items.Active[0]).toMatchObject({ identity: ref, responsibility: "agent" });
    expect(() => getTaskRoute(base, new URL("http://phren.local/v1/tasks?storeId=ffffffff&project=core"))).toThrow();
  });
  it("atomic creation publishes explicit Human metadata and rejects invalid prerequisites without partial writes", () => {
    const prerequisite = add("app", "Owner prerequisite"), dependency = identity("app", prerequisite.stableId!);
    const file = path.join(base, "core/tasks.md"), revision = doc("core").revision!;
    const rejected = saveTask(base, "core", revision, { mode: "create", task: {
      text: "Do not publish partial work", responsibility: "human", dependencies: [{ ...dependency, stableId: "ffffffff" }],
    } });
    expect(rejected.ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(doc("core").revision).toBe(revision);
    const created = saveTask(base, "core", revision, { mode: "create", task: {
      text: "Owner approval", responsibility: "human", context: "Decide after review", dependencies: [dependency],
    } });
    if (!created.ok) throw new Error(created.error);
    expect(created.data.identity).toMatchObject({ storeId: "11111111", project: "core", stableId: expect.stringMatching(/^[a-f0-9]{8}$/) });
    expect(item("core", created.data.identity.stableId)).toMatchObject({ responsibility: "human", context: "Decide after review", dependencies: [dependency] });
    expect(workNextTask(base, "core").ok).toBe(false);
    expect(created.data.doc.revision).toBe(doc("core").revision);
    expect(created.data.doc.revision).not.toBe(revision);
  });
  it("atomic saves reject stale drafts and replace or clear context and dependencies without losing identity or issue links", () => {
    const a = add("core", "Original"), b = add("app", "Prerequisite"), ref = identity("app", b.stableId!);
    updateTask(base, "core", a.stableId!, { responsibility: "human", context: "Original context", dependencies: [ref], github_issue: 17 });
    const staleRevision = doc("core").revision!;
    updateTask(base, "core", a.stableId!, { text: "Concurrent edit" });
    const file = path.join(base, "core/tasks.md"), concurrent = fs.readFileSync(file, "utf8");
    const stale = saveTask(base, "core", staleRevision, { mode: "update", stableId: a.stableId!, updates: { text: "Stale draft", context: null, dependencies: [] } });
    expect(stale).toMatchObject({ ok: false, error: taskRevisionConflict });
    expect(fs.readFileSync(file, "utf8")).toBe(concurrent);
    const changed = saveTask(base, "core", doc("core").revision!, { mode: "update", stableId: a.stableId!, updates: { text: "Reviewed draft", context: "Replacement" } });
    if (!changed.ok) throw new Error(changed.error);
    expect(item("core", a.stableId!)).toMatchObject({ line: "Reviewed draft", context: "Replacement", dependencies: [ref], githubIssue: 17, createdAt: a.createdAt });
    const cleared = saveTask(base, "core", changed.data.doc.revision!, { mode: "update", stableId: a.stableId!, updates: { context: null, dependencies: [], section: "Active" } });
    if (!cleared.ok) throw new Error(cleared.error);
    expect(cleared.data.identity).toEqual(changed.data.identity);
    expect(cleared.data.doc.items.Active[0]).toMatchObject({ id: "A1", section: "Active", stableId: a.stableId });
    expect(item("core", a.stableId!)).toMatchObject({ context: undefined, dependencies: [], responsibility: "human", githubIssue: 17 });
    expect(fs.readFileSync(file, "utf8")).not.toContain("  Context:");
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
    expect(directory.stores.find(s => s.name === "Team")).toMatchObject({ id: "22222222", role: "readonly", projects: ["app"], metadataWritable: false, metadataWriteBlock: "readonly-store" });
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
