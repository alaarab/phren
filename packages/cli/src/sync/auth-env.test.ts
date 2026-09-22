import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nonInteractiveGitEnv, runGitOrThrow } from "../utils-helpers.js";
import { runBestEffortGit } from "../cli/session-git.js";
import { isGitAuthFailure } from "./auth.js";
import { runPollGit } from "./pull.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("noninteractive Git environment", () => {
  it("overrides inherited interactive helpers while preserving caller settings", () => {
    const inherited = {
      PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "always",
      GIT_ASKPASS: "interactive-helper", SSH_ASKPASS: "interactive-helper", SSH_ASKPASS_REQUIRE: "prefer",
      GIT_SSH_COMMAND: "ssh -F /home/sam/ssh-config", GIT_OPTIONAL_LOCKS: "0",
    };
    const env = nonInteractiveGitEnv(inherited);
    expect(env).toMatchObject({
      PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "false", SSH_ASKPASS: "false", SSH_ASKPASS_REQUIRE: "force", GIT_OPTIONAL_LOCKS: "0",
      GIT_SSH_COMMAND: "ssh -F /home/sam/ssh-config",
    });
    expect(inherited.GIT_ASKPASS).toBe("interactive-helper");
    expect(nonInteractiveGitEnv(env)).toEqual(env);
    expect(nonInteractiveGitEnv({ GIT_SSH: "/usr/bin/ssh" }).GIT_SSH).toBe("/usr/bin/ssh");
  });

  it.each([false, true])("real Git cannot invoke inherited or configured askpass (username supplied: %s)", async (usernameSupplied) => {
    const scratch = path.join(process.cwd(), ".scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(path.join(scratch, "sync-askpass-"));
    roots.push(root);
    const marker = path.join(root, "prompted");
    const helper = path.join(root, "askpass");
    fs.writeFileSync(helper, '#!/bin/sh\nprintf prompted > "$PHREN_TEST_ASKPASS_MARKER"\nprintf secret\n', { mode: 0o700 });
    const config = path.join(root, "gitconfig");
    fs.writeFileSync(config, `[core]\n\taskPass = ${JSON.stringify(helper)}\n`);
    const env = nonInteractiveGitEnv({
      ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "1",
      GIT_ASKPASS: helper, SSH_ASKPASS: helper, PHREN_TEST_ASKPASS_MARKER: marker,
    });
    const child = spawn("git", ["-c", "credential.helper=", "credential", "fill"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stderr.on("data", (data) => stderr.push(data));
    child.stdout.on("data", (data) => stdout.push(data));
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdin.end(`protocol=https\nhost=github.com\n${usernameSupplied ? "username=sam\n" : ""}\n`);
    try {
      expect(await done).toBe(128);
      expect(isGitAuthFailure(Buffer.concat(stderr).toString())).toBe(true);
      expect(Buffer.concat(stdout).toString()).not.toContain("secret");
      expect(fs.existsSync(marker)).toBe(false);
    } finally { clearTimeout(timeout); child.kill(); }
  });

  it("runs the configured askpass command without output or interaction", () => {
    const env = nonInteractiveGitEnv();
    // Git invokes askpass through sh, including Git for Windows.
    const result = spawnSync("sh", ["-c", `${env.GIT_ASKPASS} 'Username for GitHub:'`], { env, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("passes the no-prompt environment to synchronous, session and polling Git processes", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
    vi.stubEnv("GIT_ASKPASS", "interactive-helper");
    vi.stubEnv("SSH_ASKPASS", "interactive-helper");
    vi.stubEnv("GCM_INTERACTIVE", "always");
    const args = ["-c", `alias.phren-test-env=!printf '%s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$SSH_ASKPASS" "$GCM_INTERACTIVE"`, "phren-test-env"];
    const expected = "0\nfalse\nfalse\nnever";
    expect(runGitOrThrow(process.cwd(), args, 5000).trim()).toBe(expected);
    expect(await runBestEffortGit(args, process.cwd())).toMatchObject({ ok: true, output: expected });
    expect(await runPollGit(process.cwd(), args)).toMatchObject({ ok: true, output: expected });
  });
});
