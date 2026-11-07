import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFindings } from "../data/access.js";
import { tryFileLock } from "../governance/locks.js";
import { readProjectTopics } from "../project-topics.js";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { applyChangeset, applyDreamProposals, pendingDreamProposals } from "./apply.js";
import { budgetTranscripts, collect, type DreamInputs, type DreamTranscript, type DreamTranscriptRoot } from "./collect.js";
import { buildDreamPrompt } from "./prompt.js";
import { dream, dreamLockPath, validateChanges, type DreamRunner } from "./run.js";
import type { DreamChange, DreamChangeset } from "./types.js";

vi.mock("fs", { spy: true });

const PROJECT = "proj";
const NOW = new Date("2026-11-06T12:00:00Z");
const EVIDENCE = [{ kind: "transcript" as const, ref: "s1#t1" }];

let tmp: { path: string; cleanup: () => void };
let store: string, repo: string, claudeRoot: string, roots: DreamTranscriptRoot[];

const findingsFile = () => path.join(store, PROJECT, "FINDINGS.md");
const truthsFile = () => path.join(store, PROJECT, "truths.md");

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(file, NOW, NOW);
}

function claudeSession(id: string, at: string, turns: Array<[string, string]>, cwd = repo): void {
  const rows: unknown[] = [];
  for (const [user, assistant] of turns) {
    rows.push({ type: "user", cwd, timestamp: at, message: { role: "user", content: user } });
    rows.push({ type: "assistant", cwd, timestamp: at, message: { role: "assistant", content: [
      { type: "text", text: assistant }, { type: "tool_use", name: "Bash", input: { command: "secret-input-body" } }] } });
    rows.push({ type: "user", cwd, timestamp: at, message: { role: "user", content: [{ type: "tool_result", content: "TOOL-OUTPUT-BODY" }] } });
  }
  writeJsonl(path.join(claudeRoot, "-repo", `${id}.jsonl`), rows);
}

function changeset(changes: DreamChange[]): DreamChangeset {
  return { project: PROJECT, runId: "r1", startedAt: NOW.toISOString(), lookback: { from: "", to: "" },
    inputs: { transcripts: 0, findings: 0, truths: 0, pages: 0 }, changes, notes: "" };
}

const finding = (fid: string) => readFindings(store, PROJECT, { includeArchived: true }).ok
  ? (readFindings(store, PROJECT, { includeArchived: true }) as { data: Array<{ stableId?: string; text: string; status: string }> }).data.find(f => f.stableId === fid)
  : undefined;
const activeTexts = () => {
  const read = readFindings(store, PROJECT);
  return read.ok ? read.data.filter(f => f.status === "active").map(f => f.text) : [];
};

beforeEach(() => {
  tmp = makeTempDir("phren-dream-");
  store = path.join(tmp.path, "store");
  repo = path.join(tmp.path, "repo");
  claudeRoot = path.join(tmp.path, "claude", "projects");
  roots = [{ source: "claude", root: claudeRoot, maxDepth: 1 }, { source: "codex", root: path.join(tmp.path, "codex"), maxDepth: 3 }];
  fs.mkdirSync(path.join(store, PROJECT), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  grantAdmin(store);
  fs.writeFileSync(findingsFile(), [
    `# ${PROJECT} Findings`, "", "## 2026-11-01", "",
    "- Builds use npm <!-- fid:aaaa1111 -->",
    "- Retries are capped at 3 <!-- fid:bbbb2222 -->",
    "- Retries are capped at three attempts <!-- fid:cccc3333 -->",
    "- The cache lives in /tmp/cache <!-- fid:dddd4444 -->", "",
  ].join("\n"));
  fs.writeFileSync(truthsFile(), `# ${PROJECT} Truths\n\n## Truths\n\n- Always use UTC _(added 2026-10-01)_\n`);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); tmp.cleanup(); });

describe("collect", () => {
  it("keeps user/assistant text and tool names, drops tool bodies, and stays inside the budget newest first", async () => {
    const big = "x".repeat(3_000);
    claudeSession("old", "2026-11-06T08:00:00Z", [["old question", big], ["old again", big], ["old third", big]]);
    claudeSession("new", "2026-11-06T11:00:00Z", [["new question", "new answer"]]);
    claudeSession("elsewhere", "2026-11-06T11:00:00Z", [["other project", "nope"]], "/somewhere/else");
    const inputs = await collect(store, PROJECT, { from: new Date(NOW.getTime() - 86_400_000), to: NOW, roots, projectDirs: [repo], gitLog: false, budgetChars: 5_000 });
    expect(inputs.transcriptChars).toBeLessThanOrEqual(5_000);
    expect(inputs.transcripts.map(t => t.session)).toEqual(["new", "old"]);
    const [newest, older] = inputs.transcripts;
    expect(newest.text).toContain("[t1] user: new question");
    expect(newest.text).toContain("[t1] tools: Bash");
    expect(older.trimmed).toBe(true);
    const all = inputs.transcripts.map(t => t.text).join("\n");
    expect(all).not.toContain("TOOL-OUTPUT-BODY");
    expect(all).not.toContain("secret-input-body");
    expect(all).not.toContain("other project");
    expect(inputs.findings.map(f => f.fid)).toEqual(["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"]);
    expect(inputs.truths).toEqual(["Always use UTC"]);
  });

  it("reads Codex rollouts, taking the cwd from session_meta and skipping out-of-window rows", async () => {
    const file = path.join(tmp.path, "codex", "2026", "11", "06", "rollout-2026-11-06T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl");
    writeJsonl(file, [
      { type: "session_meta", timestamp: "2026-11-06T10:00:00Z", payload: { cwd: repo } },
      { type: "response_item", timestamp: "2026-11-01T10:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "too old" }] } },
      { type: "response_item", timestamp: "2026-11-06T10:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "switch to pnpm" }] } },
      { type: "response_item", timestamp: "2026-11-06T10:02:00Z", payload: { type: "function_call", name: "shell", arguments: "{}" } },
      { type: "response_item", timestamp: "2026-11-06T10:03:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
    ]);
    const inputs = await collect(store, PROJECT, { from: new Date("2026-11-05T12:00:00Z"), to: NOW, roots, projectDirs: [repo], gitLog: false });
    expect(inputs.transcripts).toHaveLength(1);
    expect(inputs.transcripts[0].session).toBe("0199aaaa-bbbb-cccc-dddd-eeeeffff0000");
    expect(inputs.transcripts[0].text).toBe("[t1] user: switch to pnpm\n[t1] tools: shell\n[t1] assistant: done");
  });

  it("drops whole sessions once the remaining budget is too small to trim into", () => {
    const t = (session: string, last: string, size: number): DreamTranscript =>
      ({ source: "claude", session, cwd: "/r", first: last, last, turns: 1, text: `[t1] user: ${"y".repeat(size)}` });
    const result = budgetTranscripts([t("a", "2026-11-06T01:00:00Z", 900), t("b", "2026-11-06T02:00:00Z", 900)], 1_500);
    expect(result.kept.map(k => k.session)).toEqual(["b"]);
    expect(result.dropped).toBe(1);
  });
});

describe("prompt", () => {
  const inputs: DreamInputs = { project: PROJECT, from: "a", to: "b", transcripts: [], transcriptChars: 0, transcriptsDropped: 0,
    findings: [{ fid: "aaaa1111", date: "2026-11-01", text: "Builds use npm", status: "active" }], truths: [], topics: [], pages: [],
    gitLog: [], journal: [], budget: { sizeBytes: 100, budgetBytes: 8192, over: false, candidates: [] } };

  it("describes only the enabled phases, the allowed ops, the cap and the changeset schema", () => {
    const prompt = buildDreamPrompt(inputs, { phases: ["capture", "correct"], maxChanges: 7, now: NOW });
    expect(prompt).toContain("Capture:");
    expect(prompt).toContain("Correct:");
    expect(prompt).not.toContain("Prune:");
    expect(prompt).toContain("Allowed operations: add_finding, supersede, retract, edit.");
    expect(prompt).toContain("At most 7 changes");
    expect(prompt).toContain('{ "op": "add_finding", "text": string');
    expect(prompt).toContain('{ "op": "demote_truth", "truth": string, "reason": string }');
    expect(prompt).toContain("fid:aaaa1111");
    expect(prompt).toContain("What this memory is for");
  });

  it("scans the assembled prompt for credentials split across input rows", () => {
    expect(() => buildDreamPrompt({ ...inputs, journal: ["Authorization: Bearer", "a1".repeat(20)] }, { phases: ["capture"], maxChanges: 1, now: NOW })).toThrow(/secret/);
  });

  it("tells the model when the injected layer is over budget", () => {
    const prompt = buildDreamPrompt({ ...inputs, budget: { sizeBytes: 9000, budgetBytes: 8192, over: true, candidates: ["Old truth"] } }, { phases: ["prune"], maxChanges: 5, now: NOW });
    expect(prompt).toContain("over its 8.0 KB budget");
    expect(prompt).toContain('"Old truth"');
  });
});

describe("validateChanges", () => {
  const ctx = { fids: new Set(["aaaa1111", "bbbb2222"]), truths: ["Always use UTC"], topics: new Set(["general"]),
    phases: ["capture", "correct", "organize", "prune"] as const, maxChanges: 2 };

  it("drops changes with no evidence, unknown ops, unknown fids and those past the cap, saying why", () => {
    const { changes, dropped } = validateChanges([
      { op: "add_finding", text: "No evidence here", evidence: [] },
      { op: "rename_everything" },
      { op: "retract", findingId: "ffff0000", reason: "x", evidence: EVIDENCE },
      { op: "retract", findingId: "fid:aaaa1111", reason: "wrong", evidence: EVIDENCE },
      { op: "demote_truth", truth: "Always use UTC", reason: "rarely needed" },
      { op: "add_finding", text: "Third valid", evidence: EVIDENCE },
    ], { ...ctx, phases: [...ctx.phases] });
    expect(changes).toEqual([
      { op: "retract", findingId: "aaaa1111", reason: "wrong", evidence: EVIDENCE },
      { op: "demote_truth", truth: "Always use UTC", reason: "rarely needed" },
    ]);
    expect(dropped.map(d => [d.index, d.reason])).toEqual([
      [0, "no evidence"], [1, "unknown op"], [2, 'unknown findingId "ffff0000"'], [5, "over maxChanges (2)"],
    ]);
  });

  it("drops ops the enabled phases don't allow", () => {
    const { changes, dropped } = validateChanges([{ op: "add_finding", text: "New thing", evidence: EVIDENCE }], { ...ctx, phases: ["prune"] });
    expect(changes).toEqual([]);
    expect(dropped[0].reason).toBe("op not allowed by the enabled phases");
  });
});

describe("applyChangeset (apply mode)", () => {
  const apply = (changes: DreamChange[], injectBudgetKB = 8) => applyChangeset(store, changeset(changes), { mode: "apply", injectBudgetKB });

  it("add_finding adds a typed finding", async () => {
    const [outcome] = await apply([{ op: "add_finding", text: "Deploys need the VPN", findingType: "pitfall", evidence: EVIDENCE }]);
    expect(outcome.status).toBe("applied");
    expect(activeTexts().some(t => t.includes("Deploys need the VPN"))).toBe(true);
  });

  it("supersede adds the new text and marks the old finding superseded", async () => {
    const [outcome] = await apply([{ op: "supersede", findingId: "aaaa1111", newText: "Builds use pnpm since the monorepo move", evidence: EVIDENCE }]);
    expect(outcome.status).toBe("applied");
    expect(finding("aaaa1111")?.status).toBe("superseded");
    expect(activeTexts()).toContain("Builds use pnpm since the monorepo move");
  });

  it("retract marks the finding retracted", async () => {
    await apply([{ op: "retract", findingId: "dddd4444", reason: "cache moved", evidence: EVIDENCE }]);
    expect(finding("dddd4444")?.status).toBe("retracted");
  });

  it("edit rewrites the text and keeps the fid", async () => {
    await apply([{ op: "edit", findingId: "dddd4444", newText: "The cache lives in ~/.cache/proj", evidence: EVIDENCE }]);
    expect(finding("dddd4444")?.text).toBe("The cache lives in ~/.cache/proj");
  });

  it("merge leaves exactly one active finding with the merged text and none of the sources", async () => {
    const [outcome] = await apply([{ op: "merge", findingIds: ["bbbb2222", "cccc3333"], newText: "Retries stop after three attempts", evidence: EVIDENCE }]);
    expect(outcome.status).toBe("applied");
    const active = activeTexts();
    expect(active.filter(t => t === "Retries stop after three attempts")).toHaveLength(1);
    expect(active.filter(t => t.startsWith("Retries are capped"))).toEqual([]);
  });

  it("merge of unrelated findings supersedes both sources", async () => {
    const [outcome] = await apply([{ op: "merge", findingIds: ["aaaa1111", "dddd4444"], newText: "Tooling: pnpm builds, cache under ~/.cache/proj", evidence: EVIDENCE }]);
    expect(outcome.status).toBe("applied");
    expect(finding("aaaa1111")?.status).toBe("superseded");
    expect(finding("dddd4444")?.status).toBe("superseded");
    expect(activeTexts()).toContain("Tooling: pnpm builds, cache under ~/.cache/proj");
  });

  it("move_topic archives the finding into the topic file and removes it from FINDINGS.md", async () => {
    const topic = readProjectTopics(store, PROJECT).topics[0].slug;
    const [outcome] = await apply([{ op: "move_topic", findingId: "dddd4444", topic }]);
    expect(outcome.status).toBe("applied");
    expect(fs.readFileSync(findingsFile(), "utf8")).not.toContain("fid:dddd4444");
    expect(fs.readFileSync(path.join(store, PROJECT, "reference", "topics", `${topic}.md`), "utf8")).toContain("The cache lives in /tmp/cache <!-- fid:dddd4444 -->");
  });

  it("promote_truth pins within budget and refuses past it without a demotion", async () => {
    const [ok] = await apply([{ op: "promote_truth", findingId: "aaaa1111", text: "Builds use npm", evidence: EVIDENCE }]);
    expect(ok.status).toBe("applied");
    expect(fs.readFileSync(truthsFile(), "utf8")).toContain("- Builds use npm");
    const [refused] = await apply([{ op: "promote_truth", findingId: "dddd4444", text: "Cache in tmp", evidence: EVIDENCE }], 0.01);
    expect(refused.status).toBe("failed");
    expect(refused.detail).toContain("budget");
  });

  it("demote_truth removes the truth and keeps it as a finding", async () => {
    const [outcome] = await apply([{ op: "demote_truth", truth: "Always use UTC", reason: "rarely relevant" }]);
    expect(outcome.status).toBe("applied");
    expect(fs.readFileSync(truthsFile(), "utf8")).not.toContain("Always use UTC");
    expect(activeTexts()).toContain("Always use UTC");
  });

  it("write_page writes the page", async () => {
    const [outcome] = await apply([{ op: "write_page", page: "reference/pages/retries.md", markdown: "---\ntitle: Retries\n---\nSee fid:bbbb2222", links: [] }]);
    expect(outcome.status).toBe("applied");
    expect(fs.existsSync(path.join(store, PROJECT, "reference", "pages", "retries.md"))).toBe(true);
  });

  it("link persists a manual fragment link", async () => {
    const [outcome] = await apply([{ op: "link", findingId: "aaaa1111", entity: "NPM" }]);
    expect(outcome.status).toBe("applied");
    const links = JSON.parse(fs.readFileSync(path.join(store, ".runtime", "manual-links.json"), "utf8"));
    expect(links).toContainEqual({ entity: "npm", entityType: "fragment", sourceDoc: `${PROJECT}/FINDINGS.md`, relType: "mentions" });
  });

  it("a failed change doesn't stop the rest", async () => {
    const outcomes = await apply([
      { op: "demote_truth", truth: "No such truth", reason: "x" },
      { op: "retract", findingId: "dddd4444", reason: "gone", evidence: EVIDENCE },
    ]);
    expect(outcomes.map(o => o.status)).toEqual(["failed", "applied"]);
  });
});

describe("applyChangeset (propose mode)", () => {
  it("queues only additions and keeps structured proposals out of the queue with its evidence and leaves memory untouched", async () => {
    const before = fs.readFileSync(findingsFile(), "utf8");
    const outcomes = await applyChangeset(store, changeset([
      { op: "add_finding", text: "Deploys need the VPN", evidence: EVIDENCE },
      { op: "retract", findingId: "dddd4444", reason: "cache moved", evidence: [{ kind: "git", ref: "abc1234" }] },
    ]), { mode: "propose", injectBudgetKB: 8 });
    expect(outcomes.map(o => o.status)).toEqual(["proposed", "proposed"]);
    expect(fs.readFileSync(findingsFile(), "utf8")).toBe(before);
    const review = fs.readFileSync(path.join(store, PROJECT, "review.md"), "utf8");
    expect(review).toContain("Deploys need the VPN");
    expect(review).toContain("evidence: transcript:s1#t1");
    expect(review).not.toContain("Dream: retract");
  });
});

describe("dream", () => {
  const reply = JSON.stringify({ notes: "Captured the pnpm switch.", changes: [
    { op: "supersede", findingId: "aaaa1111", newText: "Builds use pnpm", evidence: [{ kind: "transcript", ref: "s1#t1", quote: "switch to pnpm" }] },
    { op: "add_finding", text: "Unsupported claim", evidence: [] },
  ] });
  const calls: string[] = [];
  const runner: DreamRunner = async request => { calls.push(request.prompt); return { ok: true, output: reply, model: "fake" }; };
  const run = (extra: Parameters<typeof dream>[1] = {}) => dream(PROJECT, {
    phrenPath: store, now: NOW, runner, collect: { roots, projectDirs: [repo], gitLog: false }, config: { enabled: true, mode: "apply" }, ...extra,
  });

  beforeEach(() => { calls.length = 0; claudeSession("s1", "2026-11-06T11:00:00Z", [["switch to pnpm", "done"]]); });

  it("does nothing when disabled, unless forced", async () => {
    const off = await run({ config: { enabled: false } });
    expect(off.status).toBe("disabled");
    expect(calls).toHaveLength(0);
    const forced = await run({ config: { enabled: false }, force: true });
    expect(forced.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("returns busy while another dream holds the project's lock", async () => {
    const release = tryFileLock(dreamLockPath(store, PROJECT));
    try {
      expect((await run()).status).toBe("busy");
      expect(calls).toHaveLength(0);
    } finally { release?.(); }
  });

  it("applies the valid changes, records the run, journals it and advances the window", async () => {
    const result = await run();
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ applied: 1, dropped: 1 });
    expect(result.dropped[0].reason).toBe("no evidence");
    expect(calls[0]).toContain("switch to pnpm");
    expect(finding("aaaa1111")?.status).toBe("superseded");
    const record = JSON.parse(fs.readFileSync(result.record!, "utf8"));
    expect(record.changeset.changes).toHaveLength(1);
    expect(record.outcomes[0].status).toBe("applied");
    const journal = fs.readFileSync(path.join(store, PROJECT, "dreams", "journal.md"), "utf8");
    expect(journal).toContain(`${result.runId} apply: 1 applied`);
    const last = JSON.parse(fs.readFileSync(path.join(store, PROJECT, "dreams", "last-run.json"), "utf8"));
    expect(last).toMatchObject({ runId: result.runId, to: NOW.toISOString(), status: "ok", at: last.finishedAt, trigger: "manual" });
    // The next run starts where this one ended: nothing new, so it is empty and doesn't call the model.
    const again = await run({ now: new Date(NOW.getTime() + 60_000) });
    expect(again.status).toBe("empty");
    expect(calls).toHaveLength(1);
  });

  it("dry run returns the changeset and writes nothing", async () => {
    const result = await run({ dryRun: true });
    expect(result.status).toBe("ok");
    expect(result.changeset?.changes).toHaveLength(1);
    expect(finding("aaaa1111")?.status).toBe("active");
    expect(fs.existsSync(path.join(store, PROJECT, "dreams"))).toBe(false);
  });

  it("reports a model reply that isn't JSON as failed without touching memory", async () => {
    const result = await run({ runner: async () => ({ ok: true, output: "I think things are fine." }) });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("no JSON");
    expect(finding("aaaa1111")?.status).toBe("active");
  });
});


describe("review regressions", () => {
  const secret = "ghp_" + "a1".repeat(18);
  const run = (extra: Parameters<typeof dream>[1] = {}) => dream(PROJECT, {
    phrenPath: store, now: NOW, force: true, config: { enabled: true, mode: "propose" },
    collect: { roots, projectDirs: [repo], gitLog: false }, ...extra,
  });
  const answer: DreamRunner = async () => ({ ok: true, output: JSON.stringify({ notes: "ready", changes: [
    { op: "retract", findingId: "aaaa1111", reason: "obsolete", evidence: EVIDENCE },
    { op: "edit", findingId: "dddd4444", newText: "Cache in ~/.cache", evidence: EVIDENCE },
  ] }) });

  it("applies selected stored proposals once, journals outcomes and refuses an edited target", async () => {
    const result = await run({ runner: answer });
    expect(pendingDreamProposals(store, PROJECT)).toBe(2);
    expect(fs.existsSync(path.join(store, PROJECT, "review.md"))).toBe(false);
    const applied = await applyDreamProposals(store, PROJECT, result.runId!, [0]);
    expect(applied.outcomes.map(o => o.status)).toEqual(["applied", "proposed"]);
    expect(finding("aaaa1111")?.status).toBe("retracted");
    expect(pendingDreamProposals(store, PROJECT)).toBe(1);
    fs.writeFileSync(findingsFile(), fs.readFileSync(findingsFile(), "utf8").replace("The cache lives in /tmp/cache", "Concurrent cache edit"));
    const refused = await applyDreamProposals(store, PROJECT, result.runId!, [1]);
    expect(refused.outcomes[1]).toMatchObject({ status: "failed", detail: expect.stringMatching(/changed/) });
    expect(finding("dddd4444")?.text).toBe("Concurrent cache edit");
    const before = fs.readFileSync(findingsFile(), "utf8");
    await applyDreamProposals(store, PROJECT, result.runId!, [0]);
    expect(fs.readFileSync(findingsFile(), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(store, PROJECT, "dreams", "journal.md"), "utf8")).toContain(`${result.runId}#0 applied`);
  });

  it("checks target versions after acquiring the findings lock", async () => {
    const result = await run({ runner: answer });
    const actualWrite = (await vi.importActual<typeof fs>("fs")).writeFileSync;
    const original = fs.readFileSync(findingsFile(), "utf8");
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, opts) => {
      if (String(file) === findingsFile() + ".lock") actualWrite(findingsFile(), original.replace("Builds use npm", "Concurrent builds edit"));
      return actualWrite(file, data, opts);
    });
    try {
      const record = await applyDreamProposals(store, PROJECT, result.runId!, [0]);
      expect(record.outcomes[0].status).toBe("failed");
      expect(finding("aaaa1111")).toMatchObject({ text: "Concurrent builds edit", status: "active" });
    } finally { vi.mocked(fs.writeFileSync).mockImplementation(actualWrite); }
  });

  it("refuses a deleted proposal target and rejects indices outside the run", async () => {
    const result = await run({ runner: answer });
    fs.writeFileSync(findingsFile(), fs.readFileSync(findingsFile(), "utf8").split("\n").filter(l => !l.includes("fid:aaaa1111")).join("\n"));
    expect((await applyDreamProposals(store, PROJECT, result.runId!, [0])).outcomes[0].status).toBe("failed");
    await expect(applyDreamProposals(store, PROJECT, result.runId!, [20])).rejects.toThrow("Unknown proposal");
  });

  it("leaves a truth intact when saving the replacement finding times out", async () => {
    vi.stubEnv("PHREN_FILE_LOCK_MAX_WAIT_MS", "10");
    vi.stubEnv("PHREN_FILE_LOCK_POLL_MS", "1");
    const release = tryFileLock(findingsFile());
    try {
      const before = fs.readFileSync(truthsFile(), "utf8");
      const [outcome] = await applyChangeset(store, changeset([{ op: "demote_truth", truth: "Always use UTC", reason: "not needed" }]), { mode: "apply", injectBudgetKB: 8 });
      expect(outcome.status).toBe("failed");
      expect(fs.readFileSync(truthsFile(), "utf8")).toBe(before);
    } finally { release?.(); }
  });

  it("archives lifecycle, confidence, scope, provenance and citation intact after a retraction", async () => {
    const metadata = ' <!-- scope:shared --> <!-- source:consolidation tool:dream --> [confidence 0.7]';
    const citation = '  <!-- phren:cite {"file":"src/cache.ts","line":4,"created_at":"2026-11-01"} -->';
    fs.writeFileSync(findingsFile(), fs.readFileSync(findingsFile(), "utf8").replace("<!-- fid:dddd4444 -->", `<!-- fid:dddd4444 -->${metadata}\n${citation}`));
    const topic = readProjectTopics(store, PROJECT).topics[0].slug;
    await applyChangeset(store, changeset([{ op: "retract", findingId: "dddd4444", reason: "wrong", evidence: EVIDENCE }]), { mode: "apply", injectBudgetKB: 8 });
    const before = fs.readFileSync(findingsFile(), "utf8").split("\n");
    const bullet = before.find(l => l.startsWith("- ") && l.includes("fid:dddd4444"))!;
    const [moved] = await applyChangeset(store, changeset([{ op: "move_topic", findingId: "dddd4444", topic }]), { mode: "apply", injectBudgetKB: 8 });
    expect(moved.status).toBe("applied");
    expect(fs.readFileSync(path.join(store, PROJECT, "reference", "topics", `${topic}.md`), "utf8")).toContain(bullet + "\n" + citation);
    expect(fs.readFileSync(findingsFile(), "utf8")).not.toContain("fid:dddd4444");
  });

  it("does not remove a source edited by an uncooperative writer during archiving", async () => {
    const topic = readProjectTopics(store, PROJECT).topics[0].slug;
    const rename = (await vi.importActual<typeof fs>("fs")).renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (path.dirname(String(to)) === path.join(store, PROJECT, "reference", "topics")) fs.appendFileSync(findingsFile(), "\n- Concurrent edit\n");
    });
    const [outcome] = await applyChangeset(store, changeset([{ op: "move_topic", findingId: "dddd4444", topic }]), { mode: "apply", injectBudgetKB: 8 });
    expect(outcome.status).toBe("failed");
    expect(fs.readFileSync(findingsFile(), "utf8")).toContain("fid:dddd4444");
    expect(fs.readFileSync(findingsFile(), "utf8")).toContain("Concurrent edit");
    vi.mocked(fs.renameSync).mockImplementation(rename);
  });

  it("redacts every memory input before helper invocation", async () => {
    fs.appendFileSync(truthsFile(), `- token ${secret}\n`);
    fs.appendFileSync(findingsFile(), `- leaked ${secret} <!-- fid:eeee5555 -->\n`);
    const dir = path.join(store, PROJECT, "reference", "pages"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "page.md"), `---\ntitle: ${secret}\nsummary: ${secret}\n---\n`);
    fs.mkdirSync(path.join(store, PROJECT, "dreams"), { recursive: true });
    fs.writeFileSync(path.join(store, PROJECT, "dreams", "journal.md"), `- ${secret}\n`);
    let prompt = "";
    const result = await run({ collect: { roots, projectDirs: [repo], gitLog: () => [`abc123 ${secret}`] }, runner: async req => {
      prompt = req.prompt; return { ok: true, output: '{"changes":[],"notes":"ok"}' };
    } });
    expect(result.status).toBe("ok");
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain("[redacted:");
  });

  it("sanitizes model notes, dropped values and failure diagnostics before returning or saving", async () => {
    const result = await run({ runner: async () => ({ ok: true, model: secret, output: JSON.stringify({ notes: secret, changes: [
      { op: "retract", findingId: secret, reason: "invalid", evidence: EVIDENCE },
    ] }) }) });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fs.readFileSync(result.record!, "utf8")).not.toContain(secret);
    expect(fs.readFileSync(path.join(store, PROJECT, "dreams", "journal.md"), "utf8")).not.toContain(secret);
    const failed = await run({ runner: async () => ({ ok: false, output: secret }) });
    expect(failed.message).not.toContain(secret);
    expect(failed.message).toContain("redacted");
  });

  it("holds the watermark and reports OpenCode sessions whose directory metadata is missing", async () => {
    const oc = path.join(tmp.path, "oc");
    writeJsonl(path.join(oc, "opencode-ses_unresolved.events.jsonl"), [{ seq: 0, time: "2026-11-06T11:00:00Z", type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "remember this" }] } } }]);
    const result = await run({ force: false, collect: { roots: [{ source: "opencode", root: oc, maxDepth: 0 }], projectDirs: [repo], gitLog: false } });
    expect(result.status).toBe("empty");
    expect(result.message).toContain("watermark unchanged");
    const marker = JSON.parse(fs.readFileSync(path.join(store, PROJECT, "dreams", "last-run.json"), "utf8"));
    expect(marker.to).toBe(new Date(NOW.getTime() - 86_400_000).toISOString());
  });

  it("collects plugin rows using indexed OpenCode session metadata", async () => {
    vi.stubEnv("XDG_DATA_HOME", path.join(tmp.path, "data"));
    const meta = path.join(tmp.path, "data", "opencode", "storage", "session", "project");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, "ses_known.json"), JSON.stringify({ id: "ses_known", directory: repo }));
    const oc = path.join(tmp.path, "oc");
    writeJsonl(path.join(oc, "opencode-ses_known.events.jsonl"), [{ seq: 0, time: "2026-11-06T11:00:00Z", type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "remember this" }] } } }]);
    const inputs = await collect(store, PROJECT, { from: new Date("2026-11-06T00:00:00Z"), to: NOW, roots: [{ source: "opencode", root: oc, maxDepth: 0 }], projectDirs: [repo], gitLog: false });
    expect(inputs.transcripts).toHaveLength(1);
    expect(inputs.transcripts[0]).toMatchObject({ session: "ses_known", cwd: repo, text: "[t1] user: remember this" });
    expect(inputs.unresolvedTranscripts).toBe(0);
  });
});
