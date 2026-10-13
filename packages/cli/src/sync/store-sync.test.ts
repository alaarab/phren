import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeHealth } from "../governance/policy.js";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { claimMaintenanceWriter, MAINTENANCE_LEASE_MS } from "./maintenance-writer.js";
import { BACKUP_REF_PREFIX } from "./store-merge.js";
import { storeSyncState, syncStore } from "./store-sync.js";

const windows = process.platform === "win32";
vi.setConfig({ testTimeout: windows ? 60_000 : 20_000 });

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function temp(): string {
  const dir = makeTempDir("phren-store-sync-");
  cleanups.push(dir.cleanup);
  return fs.realpathSync(dir.path);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: windows ? 45_000 : 10_000,
  }).trim();
}

const task = (bid: string, text: string, done = false, context = "") =>
  `- [${done ? "x" : " "}] ${text} <!-- bid:${bid} rank:1 created:2026-10-01T00:00:00.000Z scope:shared -->${context ? `\n  Context: ${context}` : ""}`;
const tasks = (active: string[], queue: string[], done: string[] = []) =>
  ["# demo tasks", "", "## Active", "", ...active, "", "## Queue", "", ...queue, "", "## Done", "", ...done, ""].join("\n");
const summary = (stamp: string, body: string) =>
  `# demo\n\nHand-written intro.\n\n<!-- phren:knows:start at=${stamp} -->\n## What phren knows\n\n${body}\n<!-- phren:knows:end -->\n`;

/** A bare remote and two computers' clones of one store. */
function stores() {
  const root = temp();
  const remote = path.join(root, "remote.git");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  const clone = (name: string) => {
    const dir = path.join(root, name);
    // Windows runners default core.autocrlf to true, which checks the merged
    // LF files out as CRLF on the other clone.
    git(root, "clone", "--quiet", "-c", "core.autocrlf=false", remote, dir);
    git(dir, "config", "user.email", "sync-test@example.com");
    git(dir, "config", "user.name", "Sync test");
    return dir;
  };
  const mini = clone("mini");
  writeFile(path.join(mini, ".gitignore"), ".runtime/\n.sessions/\n");
  writeFile(path.join(mini, "demo", "tasks.md"), tasks([], [task("aaaa0001", "Ship it"), task("bbbb0002", "Fix sync")]));
  writeFile(path.join(mini, "demo", "FINDINGS.md"), "# demo Findings\n\n## 2026-10-01\n\n- Base finding <!-- fid:f0000001 -->\n");
  writeFile(path.join(mini, "demo", "summary.md"), summary("2026-10-01T00:00:00.000Z", "- 1 finding."));
  git(mini, "add", ".");
  git(mini, "commit", "-m", "initial");
  git(mini, "push", "--quiet", "-u", "origin", "main");
  return { root, remote, mini, macbook: clone("macbook") };
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
}

describe("syncStore with real Git clones", () => {
  it("reconciles diverged history without losing either side and reports it", async () => {
    const { mini, macbook } = stores();
    // A task archive past 1 MiB, the size at which reading a conflict side once failed.
    const archive = path.join(".config", "task-archive", "demo.md");
    const archived = Array.from({ length: 9000 }, (_, i) => task(`d${String(i).padStart(7, "0")}`, `Archived work item ${i} ${"x".repeat(80)}`, true));
    writeFile(path.join(mini, archive), ["# demo tasks archive", "", "## 2026-09-01T00:00:00.000Z", "", ...archived, ""].join("\n"));
    commitAll(mini, "archive");
    git(mini, "push", "--quiet");
    git(macbook, "pull", "--quiet");
    expect(fs.statSync(path.join(macbook, archive)).size).toBeGreaterThan(1024 * 1024);
    fs.appendFileSync(path.join(mini, archive), `\n## 2026-10-02T00:00:00.000Z\n\n${task("eeee0005", "Archived on the Mini", true)}\n`);
    fs.appendFileSync(path.join(macbook, archive), `\n## 2026-10-03T00:00:00.000Z\n\n${task("ffff0006", "Archived on the MacBook", true)}\n`);
    // The Mini moves a task to Active but leaves its Queue copy behind (the
    // duplicate that kept every computer diverged), edits a task, adds a
    // finding and regenerates the summary.
    writeFile(path.join(mini, "demo", "tasks.md"), tasks(
      [task("aaaa0001", "Ship it", false, "release notes drafted")],
      [task("aaaa0001", "Ship it"), task("bbbb0002", "Fix sync on Linux")],
    ));
    fs.appendFileSync(path.join(mini, "demo", "FINDINGS.md"), "- Mini finding <!-- fid:f0000002 -->\n");
    writeFile(path.join(mini, "demo", "summary.md"), summary("2026-10-02T00:00:00.000Z", "- 2 findings (mini)."));
    commitAll(mini, "mini");
    git(mini, "push", "--quiet");
    // The MacBook, offline meanwhile, completes one task, adds another and
    // a finding, and regenerates the same summary block differently.
    writeFile(path.join(macbook, "demo", "tasks.md"), tasks(
      [], [task("bbbb0002", "Fix sync"), task("cccc0003", "Write docs")], [task("aaaa0001", "Ship it", true)],
    ));
    fs.appendFileSync(path.join(macbook, "demo", "FINDINGS.md"), "- MacBook finding <!-- fid:f0000003 -->\n");
    writeFile(path.join(macbook, "demo", "summary.md"), summary("2026-10-03T00:00:00.000Z", "- 2 findings (macbook)."));
    commitAll(macbook, "macbook");
    git(macbook, "fetch", "--quiet");

    const before = await storeSyncState("primary", macbook);
    expect(before).toMatchObject({ diverged: true, ahead: 1, behind: 1 });
    expect(before.warning).toContain("diverged from its remote (1 ahead, 1 behind)");

    const outcome = await syncStore(macbook, { source: "test" });
    expect(outcome.status).toBe("pushed");
    expect(outcome.backupRef?.startsWith(BACKUP_REF_PREFIX)).toBe(true);
    expect(git(macbook, "rev-parse", outcome.backupRef!)).not.toBe(git(macbook, "rev-parse", "HEAD"));

    const merged = fs.readFileSync(path.join(macbook, "demo", "tasks.md"), "utf8");
    expect(merged.match(/bid:aaaa0001/g)).toHaveLength(1);
    expect(merged).toContain("- [x] Ship it");
    expect(merged).toContain("Fix sync on Linux");
    expect(merged).toContain("Write docs");
    const archiveText = fs.readFileSync(path.join(macbook, archive), "utf8");
    for (const bid of ["d0000000", "d0008999", "eeee0005", "ffff0006"]) expect(archiveText).toContain(`bid:${bid}`);
    const findings = fs.readFileSync(path.join(macbook, "demo", "FINDINGS.md"), "utf8");
    for (const fid of ["f0000001", "f0000002", "f0000003"]) expect(findings).toContain(fid);
    // The generated block takes the remote's copy, the hand-written part stays.
    const knows = fs.readFileSync(path.join(macbook, "demo", "summary.md"), "utf8");
    expect(knows).toContain("(mini)");
    expect(knows).toContain("Hand-written intro.");
    for (const file of ["tasks.md", "FINDINGS.md", "summary.md"]) {
      expect(fs.readFileSync(path.join(macbook, "demo", file), "utf8")).not.toMatch(/^(<{7}|>{7})/m);
    }

    const after = await storeSyncState("primary", macbook);
    expect(after).toMatchObject({ diverged: false, stale: false, ahead: 0, behind: 0 });
    expect(after.warning).toBeUndefined();
    expect(getRuntimeHealth(macbook).lastSync).toMatchObject({ lastPushStatus: "saved-pushed", lastPullStatus: "ok", ahead: 0, behind: 0 });

    // The other computer converges on the same content.
    expect((await syncStore(mini, { source: "test" })).status).toBe("updated");
    expect(fs.readFileSync(path.join(mini, "demo", "tasks.md"), "utf8")).toBe(merged);
  });

  it("switches a GitHub SSH remote whose key is refused to HTTPS through gh", async () => {
    if (windows) return;
    const { root, remote, macbook } = stores();
    const bin = path.join(root, "bin");
    // OpenSSH's refusal, and a gh that is signed in.
    writeFile(path.join(bin, "ssh"), "#!/bin/sh\necho 'git@github.com: Permission denied (publickey).' >&2\nexit 255\n");
    writeFile(path.join(bin, "gh"), "#!/bin/sh\n[ \"$1\" = auth ] && [ \"$2\" = token ] && { echo token; exit 0; }\nexit 0\n");
    fs.chmodSync(path.join(bin, "ssh"), 0o755);
    fs.chmodSync(path.join(bin, "gh"), 0o755);
    // HTTPS to GitHub lands on the local bare repository.
    const globalConfig = path.join(root, "gitconfig");
    writeFile(globalConfig, `[url "${remote}"]\n\tinsteadOf = https://github.com/owner/store.git\n`);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv("GIT_SSH_COMMAND", path.join(bin, "ssh"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    git(macbook, "remote", "set-url", "origin", "git@github.com:owner/store.git");
    writeFile(path.join(macbook, "demo", "notes", "2026-10-12.md"), "- a note\n");

    const outcome = await syncStore(macbook, { source: "test" });
    expect(outcome.status).toBe("pushed");
    expect(git(macbook, "config", "--get", "remote.origin.url")).toBe("https://github.com/owner/store.git");
    // An empty helper first, so a stale keychain entry cannot answer before gh.
    expect(git(macbook, "config", "--null", "--get-all", "credential.https://github.com.helper").split("\0")).toEqual(["", `!${path.join(bin, "gh")} auth git-credential`, ""]);
    expect(git(root, "--git-dir", remote, "log", "-1", "--format=%s")).toContain("auto-save phren");
  });

  it("clears abandoned merge state and old backups before syncing", async () => {
    const { macbook, mini } = stores();
    writeFile(path.join(mini, "demo", "AGENTS.md"), "mini\n");
    commitAll(mini, "mini");
    git(mini, "push", "--quiet");
    writeFile(path.join(macbook, "demo", "AGENTS.md"), "macbook\n");
    commitAll(macbook, "macbook");
    git(macbook, "fetch", "--quiet");
    expect(() => git(macbook, "merge", "origin/main")).toThrow();
    git(macbook, "update-ref", `${BACKUP_REF_PREFIX}${Date.now()}`, "HEAD");
    const later = Date.now() + 15 * 86_400_000;

    const outcome = await syncStore(macbook, { now: later, source: "test" });
    expect(outcome.cleaned.some((line) => line.startsWith("aborted a merge"))).toBe(true);
    expect(outcome.cleaned.some((line) => line.startsWith("deleted backup"))).toBe(true);
    // A hand-written file both sides edited is a real conflict: named, not guessed.
    expect(outcome.status).toBe("conflict");
    expect(outcome.detail).toContain("demo/AGENTS.md");
    expect(fs.existsSync(path.join(macbook, ".git", "MERGE_HEAD"))).toBe(false);
    expect(getRuntimeHealth(macbook).lastSync?.lastError).toContain("demo/AGENTS.md");
  });
});

describe("maintenance writer lease", () => {
  it("lets one computer rewrite generated files until its lease lapses", () => {
    const store = temp();
    const now = Date.parse("2026-10-12T00:00:00Z");
    expect(claimMaintenanceWriter(store, "mini", now)).toEqual({ writer: true, holder: "mini" });
    expect(claimMaintenanceWriter(store, "macbook", now + 86_400_000)).toEqual({ writer: false, holder: "mini" });
    expect(claimMaintenanceWriter(store, "macbook", now + MAINTENANCE_LEASE_MS + 1)).toEqual({ writer: true, holder: "macbook" });
    expect(claimMaintenanceWriter(store, "mini", now + MAINTENANCE_LEASE_MS + 2)).toEqual({ writer: false, holder: "macbook" });
  });
});
