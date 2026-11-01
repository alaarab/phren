import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeFile } from "../phren-paths.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { AUTH_HEAL_RETRY_MS, githubHttpsUrl, healStoreAuth } from "./auth-heal.js";
import type { RunStoreGit } from "./store-merge.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const REMOTE = "git@github.com:sam/work.git";
const HTTPS = "https://github.com/sam/work.git";
const NOW = Date.parse("2026-10-01T12:00:00Z");

function temp(prefix: string): string {
  const scratch = path.join(process.cwd(), ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch, prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: nonInteractiveGitEnv(),
  }).trim();
}

async function run(cwd: string, args: string[]): Promise<{ ok: boolean; output: string; error?: string }> {
  if (args.includes("ls-remote")) throw new Error("test reached the network with git ls-remote");
  try {
    return {
      ok: true,
      output: execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: nonInteractiveGitEnv(),
      }),
    };
  } catch (error: unknown) {
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return { ok: false, output: String(failed.stdout ?? ""), error: String(failed.stderr ?? failed.message ?? "") };
  }
}

function repo(remote = REMOTE): string {
  const root = temp("phren-auth-heal-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "auth-heal-test@example.com");
  git(root, "config", "user.name", "Auth heal test");
  git(root, "remote", "add", "origin", remote);
  return root;
}

/** A `gh` on PATH that answers the sign-in probe, or refuses it. */
function gh(signedIn: boolean): string {
  const bin = temp("phren-gh-bin-");
  const file = path.join(bin, "gh");
  fs.writeFileSync(file, signedIn
    ? "#!/bin/sh\n[ \"$1\" = auth ] && [ \"$2\" = token ] && { printf 'token\\n'; exit 0; }\nexit 1\n"
    : "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  return file;
}

describe("githubHttpsUrl", () => {
  it.each([
    ["git@github.com:sam/work.git", "https://github.com/sam/work.git"],
    ["git@github.com:sam/work", "https://github.com/sam/work.git"],
    ["git@github.com:sam/work.git/", "https://github.com/sam/work.git"],
    ["ssh://git@github.com/sam/work.git", "https://github.com/sam/work.git"],
    ["ssh://git@github.com/sam/work/", "https://github.com/sam/work.git"],
  ])("converts the GitHub SSH remote %s", (remote, https) => {
    expect(githubHttpsUrl(remote)).toBe(https);
  });

  it.each([
    "https://github.com/sam/work.git",
    "git@gitlab.com:sam/work.git",
    "git@github.com:sam",
    "git@github.com:sam/work/extra/path",
    "origin",
  ])("leaves %s alone", (remote) => {
    expect(githubHttpsUrl(remote)).toBeUndefined();
  });
});

describe("healStoreAuth", () => {
  it.skipIf(process.platform === "win32")("switches a refused SSH remote to HTTPS with gh as its credential helper", async () => {
    const ghPath = gh(true);
    const root = repo();
    const calls: string[][] = [];
    const fallback = vi.fn<RunStoreGit>(async (cwd, args) => run(cwd, args));
    const runner: RunStoreGit = async (cwd, args) => {
      calls.push(args);
      return args.includes("ls-remote") ? { ok: true, output: "" } : fallback(cwd, args);
    };
    const result = await healStoreAuth(root, "origin", REMOTE, runner, NOW);
    const helper = `!${ghPath} auth git-credential`;
    expect(result).toMatchObject({ healed: true });
    expect(result.detail).toContain(`switched origin to ${HTTPS}`);
    expect(git(root, "remote", "get-url", "origin")).toBe(HTTPS);
    expect(git(root, "config", "--local", "--get-all", "credential.https://github.com.helper").split("\n").at(-1)).toBe(helper);
    expect(fs.existsSync(runtimeFile(root, "sync-auth-heal.json"))).toBe(false);
    expect(calls[0]).toEqual(["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "ls-remote", "--quiet", "--", HTTPS, "HEAD"]);
    expect(fallback.mock.calls.filter(([, args]) => args.includes("ls-remote"))).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("records the failure and leaves the remote alone when gh is not signed in", async () => {
    gh(false);
    const root = repo();
    const runner = vi.fn<RunStoreGit>(async (cwd, args) => run(cwd, args));
    const result = await healStoreAuth(root, "origin", REMOTE, runner, NOW);
    expect(result.healed).toBe(false);
    expect(result.detail).toContain("gh is not signed in here");
    expect(git(root, "remote", "get-url", "origin")).toBe(REMOTE);
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(runtimeFile(root, "sync-auth-heal.json"), "utf8")))
      .toMatchObject({ remote: REMOTE, at: NOW, detail: result.detail });
  });

  it.skipIf(process.platform === "win32")("keeps the SSH remote when HTTPS through gh fails too", async () => {
    gh(true);
    const root = repo();
    const fallback = vi.fn<RunStoreGit>(async (cwd, args) => run(cwd, args));
    const runner: RunStoreGit = async (cwd, args) => args.includes("ls-remote")
      ? { ok: false, output: "", error: "fatal: Authentication failed\nmore detail" }
      : fallback(cwd, args);
    const result = await healStoreAuth(root, "origin", REMOTE, runner, NOW);
    expect(result.healed).toBe(false);
    expect(result.detail).toContain("HTTPS through gh failed too: fatal: Authentication failed");
    expect(git(root, "remote", "get-url", "origin")).toBe(REMOTE);
    expect(() => git(root, "config", "--local", "--get", "credential.https://github.com.helper")).toThrow();
    expect(JSON.parse(fs.readFileSync(runtimeFile(root, "sync-auth-heal.json"), "utf8")))
      .toMatchObject({ remote: REMOTE, detail: result.detail });
    expect(fallback.mock.calls.filter(([, args]) => args.includes("ls-remote"))).toHaveLength(0);
  });

  it("reuses the last failure inside the retry window without probing Git", async () => {
    const root = repo();
    const stateFile = runtimeFile(root, "sync-auth-heal.json");
    const previous = { remote: REMOTE, at: NOW - AUTH_HEAL_RETRY_MS + 1, detail: "previous failure detail" };
    fs.writeFileSync(stateFile, JSON.stringify(previous) + "\n");
    const runner = vi.fn<RunStoreGit>(async () => ({ ok: true, output: "" }));
    const result = await healStoreAuth(root, "origin", REMOTE, runner, NOW);
    expect(result).toEqual({ healed: false, detail: previous.detail });
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual(previous);
  });

  it("ignores a remote that is already HTTPS without running git or recording state", async () => {
    const root = repo(HTTPS);
    const runner = vi.fn<RunStoreGit>(async () => ({ ok: true, output: "" }));
    const result = await healStoreAuth(root, "origin", HTTPS, runner, NOW);
    expect(result).toEqual({ healed: false, detail: "" });
    expect(git(root, "remote", "get-url", "origin")).toBe(HTTPS);
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(runtimeFile(root, "sync-auth-heal.json"))).toBe(false);
  });
});
