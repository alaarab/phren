import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

// Only terminal identity is supplied: checkout resolution and all Git operations
// use real linked worktrees through the same route the phone calls.
const pane = vi.hoisted(() => ({ cwd: "", foreground_cwd: "" }));
const policy = vi.hoisted(() => ({ required: false }));
vi.mock("./git-write-policy.js", async original => ({ ...await original<object>(),
  get EXPECTED_REPOSITORY_REQUIRED() { return policy.required; } }));
vi.mock("./herdr.js", async original => ({ ...await original<object>(), validateTarget: async () => pane }));
vi.mock("./health.js", async original => ({ ...await original<object>(), healthDetails: async () => ({ product: "phren-hook" }) }));
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
import { createRouteHandler, type RouteContext } from "./server-routes.js";
import { gitStatus } from "./git.js";

const exec = promisify(execFile);
let base: string | undefined;
afterEach(async () => {
  policy.required = false; vi.restoreAllMocks();
  if (base) await rm(base, { recursive: true, force: true }); base = undefined;
});
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
const route = (action: string, data: Record<string, unknown>) => paneRoute({} as PaneRouteContext,
  new URL(`http://localhost/v1/git/${action}`), { target, ...data }, {} as ServerResponse);

async function checkout() {
  const scratch = path.join(process.cwd(), ".scratch");
  await mkdir(scratch, { recursive: true });
  base = await realpath(await mkdtemp(path.join(scratch, "phren-write-checkout-")));
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
  return { root, worker, git };
}

it("refuses all writes after the pane moves, then stages only the refreshed checkout", async () => {
  const { root, worker, git } = await checkout();
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

function client() {
  const handler = createRouteHandler({ modules: { has: () => true }, streams: {}, agentHooks: { push: { status: { configured: false } } } } as unknown as RouteContext);
  return async (action: string, data: Record<string, unknown> = {}, headers: IncomingHttpHeaders = {}, method = "POST") => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ target, ...data }))]), {
      method, url: action.startsWith("/") ? action : `/v1/git/${action}`, headers,
    }) as IncomingMessage;
    let payload = "";
    const response = { statusCode: 200, setHeader: () => {}, end: (value: string) => { payload = value; } } as unknown as ServerResponse;
    await handler(request, response);
    return { status: response.statusCode, body: JSON.parse(payload) };
  };
}

it.each([
  ["stage", {}], ["unstage", {}], ["discard", {}], ["commit", {}], ["push", {}], ["pr", {}],
  ["pr/merge", {}], ["host-token", {}], ["checkout", {}], ["checkout", { create: true }],
  ["fetch", {}], ["pull", {}], ["apply", {}],
])("rejects %s without expectedRepository when the release switch is on (%j)", async (action, data) => {
  policy.required = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await client()(action as string, data as Record<string, unknown>)).toEqual({ status: 400,
    body: { error: "This app is too old to change Git safely. Update it.", code: "expected-repository-required" } });
});

it("keeps older writes working, warns once per client and route, and reports every omission for this Hook run", async () => {
  const { root, git } = await checkout();
  await writeFile(path.join(root, "file.txt"), "edit\n");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const send = client(), headers = { "x-phren-client": "ios", "x-phren-app-version": "0.1.0", "user-agent": "Phren/0.1.0" };
  const stage = { paths: ["file.txt"] };
  for (let i = 0; i < 3; i++) expect(await send("stage", stage, headers)).toEqual({ status: 200, body: { ok: true } });
  expect((await git(root, "diff", "--cached", "--name-only")).trim()).toBe("file.txt");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain("/v1/git/stage");
  expect(warn.mock.calls[0][0]).toContain("ios / 0.1.0 / Phren/0.1.0");
  for (let i = 0; i < 2; i++) expect(await send("unstage", stage, headers)).toEqual({ status: 200, body: { ok: true } });
  expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
  expect(warn).toHaveBeenCalledTimes(2);
  expect(await send("stage", stage, { "x-phren-client": "desktop" })).toEqual({ status: 200, body: { ok: true } });
  expect(warn).toHaveBeenCalledTimes(3);
  expect(await send("unstage", stage)).toEqual({ status: 200, body: { ok: true } });
  expect(warn).toHaveBeenCalledTimes(4);
  expect((await send("/v1/health/details", {}, {}, "GET")).body.gitWrites).toEqual([
    { client: "ios / 0.1.0 / Phren/0.1.0", count: 5, warning: "5 git writes without expectedRepository from ios / 0.1.0 / Phren/0.1.0" },
    { client: "desktop", count: 1, warning: "1 git writes without expectedRepository from desktop" },
    { client: "unknown client", count: 1, warning: "1 git writes without expectedRepository from unknown client" },
  ]);
  policy.required = true;
  expect((await send("status")).status).toBe(200);
  expect(await send("stage", { ...stage, expectedRepository: root }, headers)).toEqual({ status: 200, body: { ok: true } });
  expect(warn).toHaveBeenCalledTimes(4);
  policy.required = false;
  const restarted = client();
  expect((await restarted("/v1/health/details", {}, {}, "GET")).body.gitWrites).toEqual([]);
  expect(await restarted("stage", stage, headers)).toEqual({ status: 200, body: { ok: true } });
  expect(warn).toHaveBeenCalledTimes(5);
}, process.platform === "win32" ? 60_000 : 15_000);
