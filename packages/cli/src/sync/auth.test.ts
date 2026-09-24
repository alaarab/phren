import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullAtSessionStart } from "../cli/session-git.js";
import { runtimeFile } from "../phren-paths.js";
import { addStoreToRegistry, resolveAllStores, type StoreEntry } from "../store-registry.js";
import { initTestPhrenRoot } from "../test-helpers.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import {
  activeStoreAuthFailure, AUTH_BACKOFF_INITIAL_MS, AUTH_BACKOFF_MAX_MS, AUTH_UNREGISTER_AFTER_MS,
  authBackoffActive, isGitAuthFailure, readStoreAuthFailure, recordStoreAuthFailure,
  withStoreAuthBackoff,
} from "./auth.js";
import { storeCredentialCheck } from "./auth-doctor.js";
import { pollStore, runPollGit, type RunGit } from "./pull.js";

const roots: string[] = [];
const REMOTE = "https://github.com/sam/work-shared.git";
const NOW = Date.parse("2026-09-21T12:00:00Z");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const scratch = path.join(process.cwd(), ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "sync-auth-"));
  roots.push(root);
  return root;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: nonInteractiveGitEnv(),
  }).trim();
}
function fixture(): string {
  const root = temp();
  git(root, "init", "--initial-branch=knowledge");
  git(root, "config", "user.name", "sam");
  git(root, "config", "user.email", "sam@example.com");
  fs.writeFileSync(path.join(root, ".gitignore"), ".runtime/\n.sessions/\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  git(root, "remote", "add", "cloud", REMOTE);
  git(root, "update-ref", "refs/remotes/cloud/knowledge", "HEAD");
  git(root, "config", "branch.knowledge.remote", "cloud");
  git(root, "config", "branch.knowledge.merge", "refs/heads/knowledge");
  return root;
}
function failedTransport(error = "fatal: could not read Username for 'https://github.com': terminal prompts disabled") {
  return vi.fn<RunGit>(async (cwd, args) => ["fetch", "ls-remote", "push", "pull"].includes(args[0])
    ? { ok: false, output: "", error } : runPollGit(cwd, args));
}
const transportCalls = (run: ReturnType<typeof failedTransport>) => run.mock.calls.filter(([, args]) => ["fetch", "ls-remote", "push", "pull"].includes(args[0]));

describe("Git authentication failures", () => {
  it.each([
    "fatal: could not read Username for 'https://github.com': No such device or address",
    "fatal: could not read Password for 'https://sam@github.com': terminal prompts disabled",
    "fatal: Authentication failed for 'https://github.com/sam/work-shared.git/'",
    "fatal: unable to access remote: The requested URL returned error: 401",
    "fatal: unable to access remote: The requested URL returned error: 403",
    "fatal: terminal prompts disabled",
    "Permission denied (publickey).",
  ])("recognizes %s", (message) => {
    expect(isGitAuthFailure(message)).toBe(true);
    expect(isGitAuthFailure(Object.assign(new Error("git failed"), { stderr: Buffer.from(message) }))).toBe(true);
  });
  it.each(["Could not resolve host: github.com", "Connection timed out", "HTTP 503", "non-fast-forward", "CONFLICT (content)", "fatal: not a git repository", "Could not resolve https://github.com/sam/401.git", "merge conflict near line 403", null])("leaves non-auth failure %s alone", (message) => {
    expect(isGitAuthFailure(message)).toBe(false);
  });
});

describe("persistent store authentication backoff", () => {
  it("shares a startup failure with later sessions, polls and pushes without extending the backoff", async () => {
    const root = fixture();
    const run = failedTransport();
    expect((await pullAtSessionStart(root, run, NOW)).error).toContain("needs credentials");
    const first = readStoreAuthFailure(root)!;
    expect(first).toEqual({ remote: REMOTE, remoteName: "cloud", firstFailedAt: NOW, lastFailedAt: NOW, failures: 1, retryAt: NOW + AUTH_BACKOFF_INITIAL_MS });
    expect(transportCalls(run)).toHaveLength(1);
    const freshProcess = failedTransport();
    expect((await pullAtSessionStart(root, freshProcess, NOW + 1000)).error).toContain(REMOTE);
    expect((await pollStore(root, 30, freshProcess, first.retryAt - 1)).status).toBe("not-due");
    const push = withStoreAuthBackoff(freshProcess, () => NOW + 2000);
    expect((await push(root, ["push"])).error).toContain("needs credentials");
    expect(transportCalls(freshProcess)).toHaveLength(0);
    expect(readStoreAuthFailure(root)).toEqual(first);
  });

  it("shares a polling failure with startup and retries at the exponential deadline", async () => {
    const root = fixture();
    const run = failedTransport("HTTP 403");
    expect((await pollStore(root, 30, run, NOW)).status).toBe("error");
    expect((await pullAtSessionStart(root, run, NOW + 30_000)).ok).toBe(false);
    expect(transportCalls(run)).toHaveLength(1);
    let state = readStoreAuthFailure(root)!;
    for (let attempt = 2; attempt <= 8; attempt++) {
      expect((await pollStore(root, 30, run, state.retryAt - 1)).status).toBe("not-due");
      const checkedAt = state.retryAt;
      expect((await pollStore(root, 30, run, checkedAt)).status).toBe("error");
      state = readStoreAuthFailure(root)!;
      expect(state.firstFailedAt).toBe(NOW);
      expect(state.failures).toBe(attempt);
      expect(state.retryAt - checkedAt).toBe(Math.min(AUTH_BACKOFF_INITIAL_MS * 2 ** (attempt - 1), AUTH_BACKOFF_MAX_MS));
    }
    expect(transportCalls(run)).toHaveLength(8);
  });

  it("clears credentials after a successful unchanged remote check", async () => {
    const root = fixture();
    const run = failedTransport();
    await pollStore(root, 30, run, NOW);
    const retryAt = readStoreAuthFailure(root)!.retryAt;
    const head = git(root, "rev-parse", "HEAD");
    const recovered: RunGit = async (cwd, args) => args[0] === "ls-remote"
      ? { ok: true, output: `${head}\trefs/heads/knowledge` } : runPollGit(cwd, args);
    expect((await pollStore(root, 30, recovered, retryAt)).status).toBe("unchanged");
    expect(readStoreAuthFailure(root)).toBeUndefined();
    expect((await pollStore(root, 30, recovered, retryAt + 30_000)).status).toBe("unchanged");
  });

  it("does not classify merge errors or network outages as missing credentials", async () => {
    const root = fixture();
    await pollStore(root, 30, failedTransport("Could not resolve host: github.com"), NOW);
    expect(readStoreAuthFailure(root)).toBeUndefined();
    await withStoreAuthBackoff(failedTransport("HTTP 403"), () => NOW)(root, ["push"]);
    expect(readStoreAuthFailure(root)).toBeUndefined();
    recordStoreAuthFailure(root, "cloud", REMOTE, NOW);
    const at = readStoreAuthFailure(root)!.retryAt;
    await withStoreAuthBackoff(failedTransport("HTTP 503"), () => at)(root, ["fetch"]);
    expect(readStoreAuthFailure(root)).toBeUndefined();
  });

  it("does not transfer a failure to a different store or a changed remote", async () => {
    const root = fixture();
    recordStoreAuthFailure(root, "cloud", REMOTE, NOW);
    const other = fixture();
    expect(activeStoreAuthFailure(other)).toBeUndefined();
    const changed = "https://github.com/sam/work-private.git";
    git(root, "remote", "set-url", "cloud", changed);
    expect(activeStoreAuthFailure(root)).toBeUndefined();
    const run = failedTransport();
    await pullAtSessionStart(root, run, NOW + 1000);
    expect(transportCalls(run)).toHaveLength(1);
    expect(readStoreAuthFailure(root)).toMatchObject({ remote: changed, failures: 1, firstFailedAt: NOW + 1000 });
  });

  it("permits one transport probe when two callers arrive together", async () => {
    const root = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const run = vi.fn<RunGit>(async () => { await pending; return { ok: false, output: "", error: "HTTP 401" }; });
    const guarded = withStoreAuthBackoff(run, () => NOW);
    const first = guarded(root, ["fetch"]);
    const second = await guarded(root, ["ls-remote"]);
    expect(second.error).toContain("another sync");
    finish();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    expect(readStoreAuthFailure(root)?.failures).toBe(1);
  });

  it("ignores invalid runtime data and stays bounded after clock rollback", () => {
    const root = fixture();
    fs.writeFileSync(runtimeFile(root, "sync-auth.json"), '{"retryAt":"forever"}');
    expect(readStoreAuthFailure(root)).toBeUndefined();
    const state = recordStoreAuthFailure(root, "cloud", REMOTE, NOW);
    expect(authBackoffActive(state, NOW - 1)).toBe(true);
    expect(authBackoffActive(state, state.retryAt)).toBe(false);
  });
});

describe("doctor store credential repairs", () => {
  function registered() {
    const primary = temp();
    initTestPhrenRoot(primary);
    const root = fixture();
    const store: StoreEntry = { id: "abcdef12", name: "work-shared", path: root, role: "team", sync: "managed-git", remote: "https://github.com/sam/old-remote.git", projects: ["demo"] };
    addStoreToRegistry(primary, store);
    recordStoreAuthFailure(root, "cloud", REMOTE, NOW);
    return { primary, root, store };
  }
  it("reports the actual Git remote once and does not offer removal before a week", async () => {
    const { primary, store } = registered();
    const confirm = vi.fn(async (_message: string) => true);
    const check = await storeCredentialCheck(primary, store, true, confirm, NOW + AUTH_UNREGISTER_AFTER_MS);
    expect(check?.detail).toContain(`needs credentials: ${REMOTE}`);
    expect(check?.detail).not.toContain("old-remote");
    expect(confirm).not.toHaveBeenCalled();
    expect(resolveAllStores(primary)).toHaveLength(2);
  });
  it("never unregisters in read-only, noninteractive or declined repairs", async () => {
    const { primary, store } = registered();
    const confirm = vi.fn(async (_message: string) => false);
    const later = NOW + AUTH_UNREGISTER_AFTER_MS + 1;
    await storeCredentialCheck(primary, store, false, confirm, later);
    expect(confirm).not.toHaveBeenCalled();
    await storeCredentialCheck(primary, store, true, undefined, later);
    await storeCredentialCheck(primary, store, true, confirm, later);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(resolveAllStores(primary)).toHaveLength(2);
  });
  it("asks with the remote and project claims, unregisters only after yes, and keeps files", async () => {
    const { primary, root, store } = registered();
    const before = fs.readFileSync(path.join(root, ".git", "config"), "utf8");
    const confirm = vi.fn(async (_message: string) => true);
    const result = await storeCredentialCheck(primary, store, true, confirm, NOW + AUTH_UNREGISTER_AFTER_MS + 1);
    expect(confirm.mock.calls[0][0]).toContain(REMOTE);
    expect(confirm.mock.calls[0][0]).toContain("demo");
    expect(result?.ok).toBe(true);
    expect(resolveAllStores(primary)).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, ".git", "config"), "utf8")).toBe(before);
  });
  it("protects the primary store and rechecks recovery after confirmation", async () => {
    const { primary, root, store } = registered();
    const confirm = vi.fn(async (_message: string) => true);
    const later = NOW + AUTH_UNREGISTER_AFTER_MS + 1;
    expect(await storeCredentialCheck(primary, { ...store, role: "primary" }, true, confirm, later)).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    await storeCredentialCheck(primary, store, true, async () => {
      fs.rmSync(runtimeFile(root, "sync-auth.json"));
      return true;
    }, later);
    expect(resolveAllStores(primary)).toHaveLength(2);
  });

  it("surfaces each failed store once in status and doctor without probing its remote", async () => {
    const { primary, store, root } = registered();
    git(primary, "init", "--initial-branch=main");
    git(primary, "remote", "add", "origin", "https://github.com/sam/personal.git");
    recordStoreAuthFailure(primary, "origin", "https://github.com/sam/personal.git", NOW);
    vi.stubEnv("PHREN_PATH", primary);
    const { runDoctor } = await import("../link/doctor.js");
    const before = readStoreAuthFailure(root);
    const doctor = await runDoctor(primary);
    const failures = doctor.checks.filter((check) => check.detail.includes("needs credentials"));
    expect(failures).toHaveLength(2);
    expect(failures.find((check) => check.name === `store:${store.name}`)?.detail).toContain(REMOTE);
    expect(failures.find((check) => check.name === "git-remote")?.detail).toContain("https://github.com/sam/personal.git");
    expect(failures.every((check) => !check.ok)).toBe(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runStatus } = await import("../status.js");
    await runStatus();
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output.match(/needs credentials/g)).toHaveLength(2);
    expect(output.match(/https:\/\/github.com\/sam\/work-shared.git/g)).toHaveLength(1);
    expect(readStoreAuthFailure(root)).toEqual(before);
  });
});
