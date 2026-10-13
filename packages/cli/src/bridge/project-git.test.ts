import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearProjectConfigCache } from "../project-config.js";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { createRouteHandler } from "./server-routes.js";

let store: string, work: string, cleanups: (() => void)[] = [];

async function hookGet(url: string, { git = true, activity = [] as unknown[] } = {}): Promise<{ status: number; body: any }> {
  const handler = createRouteHandler({ modules: { has: (name: string) => name !== "git" || git, store }, info: {}, streams: {},
    agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() }, journal: { record: async () => {}, recent: async () => activity },
    tabActivity: { observe: async () => new Map() }, contextUsage: { read: async () => new Map() } } as never);
  let result = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
  await handler({ url, method: "GET", [Symbol.asyncIterator]: async function* () {} } as unknown as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body: JSON.parse(result) };
}

/** A checkout on branch `main` whose remote is a domain no provider claims, so nothing goes to the network. */
function checkout(name: string): string {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://git.example.com/me/forge.git");
  return fs.realpathSync(dir);
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
afterEach(() => { for (const cleanup of cleanups) cleanup(); });

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
