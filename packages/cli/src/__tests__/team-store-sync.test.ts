/**
 * Team stores: the shared repo must actually receive what phren says it saved,
 * and must not be a weaker place to write a credential than the personal store.
 *
 * Both defects were real: the commit/push block sat after a try/catch whose
 * every path returned, so it was unreachable dead code while `push_changes`
 * reported "Pushed to remote"; and the team branch of `add_finding` reached
 * `appendTeamJournal` without the secret scan or size caps every other finding
 * write goes through.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { syncTeamStores, register } from "../tools/finding.js";
import { addStoreToRegistry } from "../store-registry.js";
import type { McpContext } from "../tools/types.js";

const PROJECT = "shared-proj";

let tmpDir: string;
let cleanup: () => void;
let storePath: string;
let bareRemote: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "phren test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "phren test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

beforeEach(() => {
  ({ path: tmpDir, cleanup } = makeTempDir("phren-team-sync-"));
  grantAdmin(tmpDir);

  bareRemote = path.join(tmpDir, "remote.git");
  fs.mkdirSync(bareRemote, { recursive: true });
  git(bareRemote, ["init", "--bare", "--initial-branch=main"]);

  storePath = path.join(tmpDir, "team-store");
  fs.mkdirSync(path.join(storePath, PROJECT, "journal"), { recursive: true });
  git(storePath, ["init", "--initial-branch=main"]);
  git(storePath, ["config", "user.email", "test@example.com"]);
  git(storePath, ["config", "user.name", "phren test"]);
  fs.writeFileSync(path.join(storePath, "README.md"), "# team store\n");
  git(storePath, ["add", "-A"]);
  git(storePath, ["commit", "-m", "init"]);
  git(storePath, ["remote", "add", "origin", bareRemote]);
  git(storePath, ["push", "-u", "origin", "main"]);

  addStoreToRegistry(tmpDir, {
    id: "aabbccdd",
    name: "acme",
    path: storePath,
    role: "team",
    sync: "managed-git",
    projects: [PROJECT],
  });
});

afterEach(() => {
  cleanup();
});

describe("syncTeamStores", () => {
  it("commits and pushes a new journal entry to the shared remote", async () => {
    const journalFile = path.join(storePath, PROJECT, "journal", "2026-08-16-alice.md");
    fs.writeFileSync(journalFile, "## 2026-08-16 (alice)\n\n- [pattern] Retries need jitter\n");

    const results = await syncTeamStores(tmpDir);
    expect(results).toEqual([{ store: "acme", pushed: true }]);

    // The remote actually has it — not just a local commit.
    const remoteFiles = git(bareRemote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    expect(remoteFiles).toContain(`${PROJECT}/journal/2026-08-16-alice.md`);
    const blob = git(bareRemote, ["show", `main:${PROJECT}/journal/2026-08-16-alice.md`]);
    expect(blob).toContain("Retries need jitter");
  });

  it("reports nothing when the team store has no changes", async () => {
    expect(await syncTeamStores(tmpDir)).toEqual([]);
  });

  it("does not stage files outside the team-safe pathspecs", async () => {
    fs.writeFileSync(path.join(storePath, PROJECT, "journal", "2026-08-16-bob.md"), "- [gotcha] X\n");
    fs.writeFileSync(path.join(storePath, "secrets.txt"), "not team-safe\n");

    const results = await syncTeamStores(tmpDir);
    expect(results).toEqual([{ store: "acme", pushed: true }]);

    const remoteFiles = git(bareRemote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    expect(remoteFiles).toContain(`${PROJECT}/journal/2026-08-16-bob.md`);
    expect(remoteFiles).not.toContain("secrets.txt");
  });

  it("surfaces a push failure instead of reporting success", async () => {
    git(storePath, ["remote", "set-url", "origin", path.join(tmpDir, "does-not-exist.git")]);
    fs.writeFileSync(path.join(storePath, PROJECT, "journal", "2026-08-16-carol.md"), "- [decision] Y\n");

    const results = await syncTeamStores(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].pushed).toBe(false);
    expect(results[0].error).toBeTruthy();
  });
});

// ── add_finding into a team store ────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

describe("add_finding into a team store", () => {
  let server: ReturnType<typeof makeMockServer>;
  let indexed: string[];

  function journalText(): string {
    const dir = path.join(storePath, PROJECT, "journal");
    if (!fs.existsSync(dir)) return "";
    return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  }

  beforeEach(() => {
    server = makeMockServer();
    indexed = [];
    const ctx: McpContext = {
      phrenPath: tmpDir,
      profile: "test",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: (file: string) => { indexed.push(file); },
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as never, ctx);
  });

  async function addFinding(finding: string | string[]) {
    const res = await server.call("add_finding", { project: `acme/${PROJECT}`, finding });
    return JSON.parse(res.content[0].text);
  }

  it("writes an ordinary finding to the journal and indexes it", async () => {
    const result = await addFinding("Retries need jitter to avoid thundering herds");
    expect(result.ok).toBe(true);
    expect(journalText()).toContain("Retries need jitter");
    expect(indexed.some((f) => f.includes(path.join(PROJECT, "journal")))).toBe(true);
  });

  it("refuses a credential instead of committing it to the shared repo", async () => {
    // The journal is pushed to a repo shared with colleagues, so the shared
    // store must not be a weaker place to write a secret than the personal one.
    const result = await addFinding("auth works with token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/secret/i);
    expect(journalText()).not.toContain("sk-ant-api03");
  });

  it("keeps the clean findings from a batch and reports the rejected one", async () => {
    const result = await addFinding([
      "The queue drains fastest with 4 workers",
      "db password is hunter2 postgres://admin:hunter2@db.internal:5432/app",
    ]);
    expect(journalText()).toContain("drains fastest with 4 workers");
    expect(journalText()).not.toContain("hunter2");
    expect(result.data.rejected).toHaveLength(1);
  });

  it("applies the same size caps as the personal store", async () => {
    const tooLong = await addFinding("x".repeat(5001));
    expect(tooLong.ok).toBe(false);
    expect(String(tooLong.error)).toContain("5000");

    const tooMany = await addFinding(Array.from({ length: 101 }, (_, i) => `finding ${i}`));
    expect(tooMany.ok).toBe(false);
    expect(String(tooMany.error)).toContain("100");
    expect(journalText()).not.toContain("finding 0");
  });

  it("reports an error field when nothing could be written", async () => {
    const result = await addFinding("token sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    // ok:false with a success-shaped message and no error field left an agent
    // nothing to act on, so it would just retry.
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
