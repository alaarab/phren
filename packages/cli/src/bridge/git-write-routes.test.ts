import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

// Only terminal identity is supplied: checkout resolution and all Git operations
// use real linked worktrees through the same route the phone calls.
const pane = vi.hoisted(() => ({ cwd: "", foreground_cwd: "" }));
vi.mock("./herdr.js", async original => ({ ...await original<object>(), validateTarget: async () => pane }));
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
import { gitStatus } from "./git.js";

const exec = promisify(execFile);
let base: string | undefined;
afterEach(async () => { if (base) await rm(base, { recursive: true, force: true }); base = undefined; });
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
const route = (action: string, data: Record<string, unknown>) => paneRoute({} as PaneRouteContext,
  new URL(`http://localhost/v1/git/${action}`), { target, ...data }, {} as ServerResponse);

it("refuses all writes after the pane moves, then stages only the refreshed checkout", async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "phren-write-checkout-")));
  const root = path.join(base, "repo"), worker = path.join(base, "worker");
  const env = { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args], { env })).stdout;
  await exec("git", ["init", "-q", "-b", "main", root], { env });
  await writeFile(path.join(root, "file.txt"), "base\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");
  await git(root, "worktree", "add", "-qb", "feature", worker);
  await writeFile(path.join(worker, "file.txt"), "worker edit\n");
  pane.cwd = pane.foreground_cwd = root;
  const previous = await route("status", {}) as Awaited<ReturnType<typeof gitStatus>>;
  pane.foreground_cwd = worker; // Same conversation, now in a different checkout.
  for (const action of ["stage", "unstage", "discard", "commit", "push", "pr"]) {
    await expect(route(action, { expectedRepository: previous.repository, paths: ["file.txt"], message: "must not commit" }))
      .rejects.toMatchObject({ status: 409, details: { code: "git-checkout-changed" } });
  }
  expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
  expect(await git(worker, "diff", "--cached", "--name-only")).toBe("");
  expect(await readFile(path.join(worker, "file.txt"), "utf8")).toBe("worker edit\n");
  expect(await git(worker, "rev-parse", "HEAD")).toBe(await git(root, "rev-parse", "HEAD"));
  for (const expectedRepository of ["relative", "", null, 17, "/" + "a".repeat(4096), root + "\0"]) {
    await expect(route("stage", { expectedRepository, paths: ["file.txt"] })).rejects.toThrow();
  }
  const refreshed = await route("status", {}) as Awaited<ReturnType<typeof gitStatus>>;
  await expect(route("stage", { expectedRepository: refreshed.repository, paths: ["file.txt"] })).resolves.toEqual({ ok: true });
  expect((await git(worker, "diff", "--cached", "--name-only")).trim()).toBe("file.txt");
  expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
  // Older callers remain compatible when the optional guard is absent.
  await expect(route("unstage", { paths: ["file.txt"] })).resolves.toEqual({ ok: true });
  expect(await git(worker, "diff", "--cached", "--name-only")).toBe("");
}, process.platform === "win32" ? 60_000 : 15_000);
