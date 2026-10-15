import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProjectConfigCache } from "../project-config.js";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { createRouteHandler } from "./server-routes.js";

let store: string, work: string, cleanups: (() => void)[] = [];

async function hookGet(url: string, { git = true, activity = [] as unknown[], data = undefined as unknown } = {}): Promise<{ status: number; body: any }> {
  const handler = createRouteHandler({ modules: { has: (name: string) => name !== "git" || git, store }, info: {}, streams: {},
    agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() }, journal: { record: async () => {}, recent: async () => activity },
    tabActivity: { observe: async () => new Map() }, contextUsage: { read: async () => new Map() } } as never);
  let result = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
  await handler({ url, method: data === undefined ? "GET" : "POST", headers: {}, [Symbol.asyncIterator]: async function* () { if (data !== undefined) yield Buffer.from(JSON.stringify(data)); } } as unknown as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body: JSON.parse(result) };
}

/** A checkout on branch `main` whose remote is a domain no provider claims, so nothing goes to the network. */
function checkout(name: string): string {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://git.example.com/me/forge.git");
  // native: on Windows the plain realpath keeps 8.3 short names (RUNNER~1); git and the Hook give the long one.
  return fs.realpathSync.native(dir);
}

function register(project: string, sourcePath: string) {
  fs.mkdirSync(path.join(store, project), { recursive: true });
  fs.writeFileSync(path.join(store, project, "phren.project.yaml"), `sourcePath: ${sourcePath}\n`);
  fs.writeFileSync(path.join(store, project, "FINDINGS.md"), `# ${project} Findings\n`);
}

beforeEach(() => {
  const s = makeTempDir("project-git-store-"), w = makeTempDir("project-git-work-");
  store = s.path; work = w.path; cleanups = [s.cleanup, w.cleanup];
  initTestPhrenRoot(store);
  clearProjectConfigCache();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const cleanup of cleanups) cleanup(); });

describe("GET /v1/projects/:project/git", () => {
  it("reads the registered checkout's branch and host", async () => {
    const repo = checkout("forge-registered");
    register("forge-registered", repo);
    const { status, body } = await hookGet("/v1/projects/forge-registered/git");
    expect(status).toBe(200);
    expect(body).toMatchObject({ project: "forge-registered", directory: repo, branch: "main", available: false, reason: "unknown-host" });
    expect(body.host).toMatchObject({ domain: "git.example.com", source: "none" });
  });

  it("falls back to the folder a session ran in when the recorded path is another computer's", async () => {
    const repo = checkout("forge-elsewhere");
    register("forge-elsewhere", "/nowhere/forge-elsewhere");
    const { status, body } = await hookGet("/v1/projects/forge-elsewhere/git", { activity: [{ directory: path.join(repo, "src"), at: "2026-10-12T00:00:00Z" }] });
    expect(status).toBe(200);
    expect(body.directory).toBe(repo);
  });

  it("says when this computer has no checkout, and needs the git module", async () => {
    register("forge-missing", "/nowhere/forge-missing");
    expect(await hookGet("/v1/projects/forge-missing/git")).toMatchObject({ status: 404, body: { code: "no-checkout" } });
    expect((await hookGet("/v1/projects/forge-missing/git", { git: false })).status).toBe(404);
    expect((await hookGet("/v1/projects/..%2Fetc/git")).status).toBe(400);
  });
});

describe("POST /v1/projects/:project/git/host-token", () => {
  it("uses the same checkout lookup and no-checkout refusal, with the git module required", async () => {
    register("forge-missing", "/nowhere/forge-missing");
    const data = { token: "private-test-token", expectedHost: "gitlab.example.com" };
    expect(await hookGet("/v1/projects/forge-missing/git/host-token", { data }))
      .toEqual({ status: 404, body: { error: "No checkout of this project on this computer.", code: "no-checkout" } });
    expect((await hookGet("/v1/projects/forge-missing/git/host-token", { data, git: false })).status).toBe(404);
  });

  it("checks the fresh host before contacting it, saves only a matching token, and keeps secrets out of replies and logs", async () => {
    const repo = checkout("forge-connect");
    register("forge-connect", "/nowhere/forge-connect");
    execFileSync("git", ["-C", repo, "remote", "set-url", "origin", "https://gitlab.example.com/me/forge.git"]);
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(work, "bridge"));
    const token = "private-test-token";
    const logs = ["log", "warn", "error", "info", "debug"].map(method => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    const fetchHost = vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: "sam" })));
    vi.stubGlobal("fetch", fetchHost);
    const route = "/v1/projects/forge-connect/git/host-token";
    const activity = [{ directory: path.join(repo, "src"), at: "2026-10-12T00:00:00Z" }];
    const file = path.join(work, "bridge", "git-hosts.json");
    const mismatch = await hookGet(route, { activity, data: { token, expectedHost: "gitlab.old.example.com" } });
    expect(mismatch).toEqual({ status: 409, body: { error: "The project's remote changed. Reopen to review the new host.", code: "host-changed" } });
    expect(fetchHost).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    const missingHost = await hookGet(route, { activity, data: { token } });
    expect(missingHost.status).toBe(400);
    expect(fetchHost).not.toHaveBeenCalled();
    const success = await hookGet(route, { activity, data: { token, expectedHost: "gitlab.example.com" } });
    expect(success).toMatchObject({ status: 200, body: { ok: true, domain: "gitlab.example.com", user: "sam" } });
    expect(fetchHost).toHaveBeenCalledTimes(1);
    expect(fetchHost.mock.calls[0][1].headers["PRIVATE-TOKEN"]).toBe(token);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).hosts["gitlab.example.com"].token).toBe(token);
    fetchHost.mockResolvedValue(new Response(JSON.stringify({ message: `invalid token ${token}` }), { status: 500 }));
    const refused = await hookGet(route, { activity, data: { token, expectedHost: "gitlab.example.com" } });
    expect(refused).toMatchObject({ status: 200, body: { ok: false, reason: "failed" } });
    fetchHost.mockResolvedValue(new Response(JSON.stringify({ username: token })));
    const echoed = await hookGet(route, { activity, data: { token, expectedHost: "gitlab.example.com" } });
    expect(echoed).toMatchObject({ status: 200, body: { ok: true, user: "[redacted]" } });
    expect(JSON.stringify([mismatch, missingHost, success, refused, echoed, ...logs.map(log => log.mock.calls)])).not.toContain(token);
  });
});
