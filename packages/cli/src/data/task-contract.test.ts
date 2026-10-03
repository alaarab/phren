/** Prepared for the consolidated RC. Do not run during build-only development. */
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addTask, readTasks, updateTask, completeTask, tidyDoneTasks, workNextTask, claimTask } from "./tasks.js";
import { taskReadiness, taskIdentity } from "./task-contract.js";
import { getTaskRoute, updateTaskRoute } from "../bridge/task-routes.js";
import { mergeTasksByBid } from "../sync/task-merge.js";

let base: string, cleanup: () => void;
beforeEach(() => {
  ({ path: base, cleanup } = makeTempDir("task-contract-"));
  grantAdmin(base);
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
  it("defaults legacy tasks to agent without writing or relabeling them", () => {
    const file = path.join(base, "core/tasks.md"), source = "# tasks\n\n## Queue\n\n- [ ] Legacy\n";
    fs.writeFileSync(file, source);
    const d = doc("core");
    expect(taskReadiness(base, d, d.items.Queue[0])).toMatchObject({ responsibility: "agent", readiness: "ready" });
    expect(fs.readFileSync(file, "utf8")).toBe(source);
  });
  it("reassigns and moves the same stable task without losing context, creation or history", () => {
    const a = add("core", "Keep identity");
    expect(updateTask(base, "core", a.stableId!, { responsibility: "human", context: "Owner account action", section: "Active" }).ok).toBe(true);
    expect(updateTask(base, "core", a.stableId!, { responsibility: "agent", section: "Queue" }).ok).toBe(true);
    const restored = item("core", a.stableId!);
    expect(restored).toMatchObject({ stableId: a.stableId, createdAt: a.createdAt, context: "Owner account action", responsibility: "agent", section: "Queue" });
    expect(restored.history).toHaveLength(2);
    expect(restored.history![0].change).toContain("agent -> human");
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
});
