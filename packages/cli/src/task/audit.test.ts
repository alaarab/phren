import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { readTasks, type TaskItem } from "../data/tasks.js";
import { tryFileLock } from "../governance/locks.js";
import type { DreamRunner } from "../dream/run.js";
import {
  AUDIT_LIMIT_DEFAULT,
  EMBEDDED_AUDIT_RULES,
  auditCandidates,
  auditRules,
  auditTasks,
  buildAuditPrompt,
  matchVerdicts,
  parseAuditReply,
  readAuditLastRun,
  taskAuditLockPath,
  taskAuditsDir,
} from "./audit.js";

const PROJECT = "proj";
const NOW = new Date("2026-11-06T12:00:00Z");
/** Any ISO date; the note's day is the run's local date, which the test never pins exactly. */
const DAY = /\d{4}-\d{2}-\d{2}/;

let tmp: { path: string; cleanup: () => void };
let store: string;

const tasksFile = () => path.join(store, PROJECT, "tasks.md");

function seedTasks(): void {
  fs.writeFileSync(tasksFile(), [
    `# ${PROJECT} tasks`, "",
    "## Active", "",
    "- Ship the login fix <!-- bid:aaaa1111 lastActivity:2026-11-01T00:00:00Z -->",
    "  Context: started last week",
    "- Refactor the cache <!-- bid:bbbb2222 lastActivity:2026-11-03T00:00:00Z -->",
    "- Write the docs <!-- bid:cccc3333 lastActivity:2026-11-05T00:00:00Z -->",
    "- A task that predates stable ids",
    "",
    "## Queue", "",
    "- Hire nobody <!-- bid:dddd4444 lastActivity:2026-11-02T00:00:00Z -->",
    "",
    "## Done", "",
    "- Already shipped <!-- bid:eeee5555 -->",
    "",
  ].join("\n"));
}

function findTask(bid: string): TaskItem | undefined {
  const read = readTasks(store, PROJECT);
  if (!read.ok) throw new Error(read.error);
  return [...read.data.items.Active, ...read.data.items.Queue, ...read.data.items.Done].find((item) => item.stableId === bid);
}

const replyOf = (verdicts: unknown[]) => JSON.stringify({ verdicts });
/** A runner that records each prompt and replies with `verdicts`. */
function fakeRunner(verdicts: unknown[], opts: { output?: string } = {}): { runner: DreamRunner; prompts: string[]; cwds: string[] } {
  const prompts: string[] = [], cwds: string[] = [];
  return {
    prompts, cwds,
    runner: async (request) => {
      prompts.push(request.prompt); cwds.push(request.cwd);
      return { ok: true, ...(opts.output !== undefined ? { output: opts.output } : { output: replyOf(verdicts) }) };
    },
  };
}

const run = (extra: Parameters<typeof auditTasks>[1] = {}) => auditTasks(PROJECT, { phrenPath: store, now: NOW, ...extra });

beforeEach(() => {
  tmp = makeTempDir("phren-task-audit-");
  store = tmp.path;
  fs.mkdirSync(path.join(store, PROJECT), { recursive: true });
  grantAdmin(store);
  seedTasks();
});

afterEach(() => tmp.cleanup());

describe("auditCandidates", () => {
  it("keeps Active and Queue tasks with a stable id, oldest first, at most the limit", () => {
    const read = readTasks(store, PROJECT);
    if (!read.ok) throw new Error(read.error);
    expect(auditCandidates(read.data, AUDIT_LIMIT_DEFAULT).map((item) => item.stableId))
      .toEqual(["aaaa1111", "dddd4444", "bbbb2222", "cccc3333"]);
    expect(auditCandidates(read.data, 2).map((item) => item.stableId)).toEqual(["aaaa1111", "dddd4444"]);
  });
});

describe("parseAuditReply and matchVerdicts", () => {
  const candidates = [
    { stableId: "aaaa1111" },
    { stableId: "bbbb2222" },
  ];

  it("tolerates a code fence and refuses prose or malformed JSON", () => {
    expect(parseAuditReply("```json\n" + replyOf([{ bid: "aaaa1111", verdict: "valid" }]) + "\n```")).toMatchObject({ ok: true });
    expect(parseAuditReply("I looked at everything and it seems fine.")).toMatchObject({ ok: false });
    expect(parseAuditReply("{verdicts: not json}")).toMatchObject({ ok: false });
    expect(parseAuditReply('{"verdicts": [{"bid": "aaaa1111", "verdict": "finished"}]}')).toMatchObject({ ok: false });
  });

  it("drops unknown bids, duplicates and verdicts missing the text they need", () => {
    const { verdicts, dropped } = matchVerdicts([
      { bid: "ffff0000", verdict: "done", evidence: "no such task" },
      { bid: "aaaa1111", verdict: "done" },
      { bid: "aaaa1111", verdict: "valid" },
      { bid: "bbbb2222", verdict: "done", evidence: "commit abc123" },
    ], candidates);
    expect(verdicts).toEqual([{ bid: "bbbb2222", verdict: "done", evidence: "commit abc123" }]);
    expect(dropped.map((drop) => drop.reason)).toEqual([
      'unknown bid "ffff0000"', "a done verdict needs evidence", "the task already has a verdict in this reply",
    ]);
  });
});

describe("auditRules and buildAuditPrompt", () => {
  it("falls back to the embedded rules without an installed skill", () => {
    expect(auditRules(store, PROJECT)).toBe(EMBEDDED_AUDIT_RULES);
  });

  it("reads the installed skill's body, without its frontmatter", () => {
    fs.mkdirSync(path.join(store, "global", "skills", "phren-task-audit"), { recursive: true });
    fs.writeFileSync(path.join(store, "global", "skills", "phren-task-audit", "SKILL.md"),
      "---\nname: phren-task-audit\ndescription: Audit tasks\n---\nCustom audit rules body.\n");
    expect(auditRules(store, PROJECT)).toBe("Custom audit rules body.");
  });

  it("lists each candidate with its bid, section and a cut context, then the JSON-only instruction", () => {
    const read = readTasks(store, PROJECT);
    if (!read.ok) throw new Error(read.error);
    const candidates = auditCandidates(read.data, AUDIT_LIMIT_DEFAULT);
    const long = `${"x".repeat(700)}`;
    const prompt = buildAuditPrompt("RULES.", [{ ...candidates[0]!, context: long }, candidates[1]!]);
    expect(prompt).toContain("RULES.");
    expect(prompt).toContain("- bid:aaaa1111 (Active) Ship the login fix");
    expect(prompt).toContain(`— Context: ${long.slice(0, 600)}`);
    expect(prompt).not.toContain(long.slice(600));
    expect(prompt).toContain('- bid:dddd4444 (Queue) Hire nobody');
    expect(prompt).toContain('Reply with JSON only: {"verdicts":[{"bid":"xxxxxxxx","verdict":"done|partial|valid|obsolete|unresolved"');
  });
});

describe("auditTasks", () => {
  it("closes a done task with its evidence and records the run", async () => {
    const { runner } = fakeRunner([{ bid: "bbbb2222", verdict: "done", evidence: "PR #12 merged the fix" }]);
    const result = await auditTasks(PROJECT, { phrenPath: store, now: NOW, runner, trigger: "scheduled" });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ candidates: 4, done: 1, closed: 1, noted: 0, dropped: 0 });
    const task = findTask("bbbb2222");
    expect(task?.section).toBe("Done");
    expect(task?.checked).toBe(true);
    expect(task?.context).toMatch(new RegExp(`^Weekly audit ${DAY.source}: done: PR #12 merged the fix$`));
    const record = JSON.parse(fs.readFileSync(result.record!, "utf8"));
    expect(record.verdicts).toEqual([{ bid: "bbbb2222", verdict: "done", evidence: "PR #12 merged the fix" }]);
    expect(record.applied).toEqual([{ bid: "bbbb2222", action: "closed", detail: expect.stringContaining("done: PR #12 merged the fix") }]);
    expect(record.trigger).toBe("scheduled");
    const last = readAuditLastRun(store, PROJECT);
    expect(last).toMatchObject({ status: "ok", trigger: "scheduled", counts: { closed: 1, candidates: 4 } });
    expect(fs.readdirSync(taskAuditsDir(store, PROJECT))).toContain(path.basename(result.record!));
  });

  it("does nothing with a done verdict that has no evidence", async () => {
    const before = fs.readFileSync(tasksFile(), "utf8");
    const { runner } = fakeRunner([{ bid: "aaaa1111", verdict: "done" }]);
    const result = await run({ runner });
    expect(result.status).toBe("ok");
    expect(result.dropped?.[0]?.reason).toBe("a done verdict needs evidence");
    expect(fs.readFileSync(tasksFile(), "utf8")).toBe(before);
  });

  it("notes a partial and an obsolete task without moving or removing either", async () => {
    const { runner } = fakeRunner([
      { bid: "cccc3333", verdict: "partial", remainder: "the caching chapter is still missing" },
      { bid: "dddd4444", verdict: "obsolete", evidence: "the hiring plan was replaced by the contractor budget" },
    ]);
    const result = await run({ runner });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ closed: 0, noted: 2, done: 0, partial: 1, obsolete: 1 });
    const partial = findTask("cccc3333");
    expect(partial?.section).toBe("Active");
    expect(partial?.context).toMatch(new RegExp(`^Weekly audit ${DAY.source}: remaining: the caching chapter is still missing$`));
    const obsolete = findTask("dddd4444");
    expect(obsolete?.section).toBe("Queue");
    expect(obsolete?.context).toMatch(new RegExp(`^Weekly audit ${DAY.source}: looks obsolete: the hiring plan was replaced by the contractor budget$`));
  });

  it("appends the note to a task that already has context", async () => {
    const { runner } = fakeRunner([{ bid: "aaaa1111", verdict: "partial", remainder: "still failing on Safari" }]);
    await run({ runner });
    expect(findTask("aaaa1111")?.context).toMatch(new RegExp(`^started last week; Weekly audit ${DAY.source}: remaining: still failing on Safari$`));
  });

  it("ignores unknown bids and records why", async () => {
    const { runner } = fakeRunner([{ bid: "ffff0000", verdict: "done", evidence: "made up" }]);
    const result = await run({ runner });
    expect(result.status).toBe("ok");
    expect(result.dropped).toEqual([{ index: 0, bid: "ffff0000", reason: 'unknown bid "ffff0000"' }]);
    expect(result.counts).toMatchObject({ candidates: 4, dropped: 1, closed: 0 });
  });

  it("fails without touching a task when the reply is not JSON", async () => {
    const before = fs.readFileSync(tasksFile(), "utf8");
    const { runner } = fakeRunner([], { output: "Everything looks done to me." });
    const result = await run({ runner });
    expect(result.status).toBe("failed");
    expect(fs.readFileSync(tasksFile(), "utf8")).toBe(before);
    expect(readAuditLastRun(store, PROJECT)).toMatchObject({ status: "failed" });
    expect(fs.readdirSync(taskAuditsDir(store, PROJECT))).toEqual(["last-run.json"]);
  });

  it("reports busy while another audit holds the project's lock", async () => {
    const release = tryFileLock(taskAuditLockPath(store, PROJECT));
    try {
      const { runner } = fakeRunner([]);
      const result = await run({ runner });
      expect(result.status).toBe("busy");
    } finally { release?.(); }
  });

  it("writes an empty marker and never calls the model when there is nothing to audit", async () => {
    fs.writeFileSync(tasksFile(), `# ${PROJECT} tasks\n\n## Active\n\n- A task that predates stable ids\n\n## Queue\n\n`);
    const { runner, prompts } = fakeRunner([]);
    const result = await run({ runner });
    expect(result).toMatchObject({ status: "empty" });
    expect(prompts).toHaveLength(0);
    expect(readAuditLastRun(store, PROJECT)).toMatchObject({ status: "empty", counts: { candidates: 0 } });
  });

  it("dry run reports what would happen and writes nothing", async () => {
    const before = fs.readFileSync(tasksFile(), "utf8");
    const { runner } = fakeRunner([{ bid: "aaaa1111", verdict: "done", evidence: "PR #12" }]);
    const result = await run({ runner, dryRun: true });
    expect(result.status).toBe("ok");
    expect(result.message).toBe("Dry run: 1 task would close, 0 would get a note, 0 dropped.");
    expect(fs.readFileSync(tasksFile(), "utf8")).toBe(before);
    expect(fs.existsSync(taskAuditsDir(store, PROJECT))).toBe(false);
    expect(readAuditLastRun(store, PROJECT)).toBeUndefined();
  });

  it("sends at most `limit` tasks, oldest first, from the project's store folder", async () => {
    const { runner, prompts, cwds } = fakeRunner([]);
    await run({ runner, limit: 2 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("bid:aaaa1111");
    expect(prompts[0]).toContain("bid:dddd4444");
    expect(prompts[0]).not.toContain("bid:bbbb2222");
    expect(prompts[0]).not.toContain("bid:cccc3333");
    expect(cwds[0]).toBe(path.join(store, PROJECT));
  });
});
