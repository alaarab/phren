/**
 * The dreaming eval's fixture: a small store and synthetic transcripts that
 * contain exactly the situations a dream should handle.
 *
 *  1. A finding contradicted by a later transcript (the dev server moved off port 3000).
 *  2. Two findings that say the same thing (migrate before tests).
 *  3. A decision stated in a transcript and never saved (Postgres advisory locks
 *     instead of Redis for the rate limiter).
 *  4. Truths over the injected budget, some recently cited and some stale.
 *  plus a correct finding nothing should touch (the control).
 *
 * Transcripts are written where phren's readers look for them under `home`:
 * a Claude Code session (`.claude/projects/<cwd>/<id>.jsonl`) and a Codex
 * rollout (`.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), both with the
 * project's checkout as their cwd.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { writeRootManifest } from "../../shared.js";

export const EVAL_PROJECT = "lantern";
/** Fixed clock for the fixture; transcripts fall inside the default 24 h lookback from here. */
export const EVAL_NOW = new Date("2026-11-06T12:00:00.000Z");
export const EVAL_BUDGET_KB = 8;

export const FIDS = {
  contradicted: "a1000001",
  dupA: "a1000002",
  dupB: "a1000003",
  control: "a1000004",
} as const;

export const CLAUDE_SESSION = "5f0c2a7e-1b7d-4c55-9a52-0d9a6b3e7c11";
export const CODEX_SESSION = "0199a3c4-7d10-7b2e-9f61-2c8d4e5a6b70";

/** Phrases the scripted model and the scorer key on. */
export const FACTS = {
  newPort: "4100",
  decisionKeyword: "advisory lock",
  decisionPattern: /advisory[- ]lock/i,
  decisionTopicPattern: /rate[- ]?limit/i,
};

export interface EvalFixture {
  root: string;
  /** The phren store (PHREN_PATH). */
  store: string;
  /** HOME for the run: where the transcripts live. */
  home: string;
  /** The project's checkout (sourcePath, and the transcripts' cwd). */
  repo: string;
  project: string;
  now: Date;
  budgetKB: number;
  /** Truths nobody has used in months: the expected demotions. */
  staleTruths: string[];
  /** Truths cited in the last week: demoting them is a mistake. */
  freshTruths: string[];
}

const FRESH_TRUTHS = [
  "The production database is Postgres 16 on the managed cluster; never point local tooling at it.",
  "Releases are cut from main by the release workflow only; never publish from a laptop.",
  "The public API is versioned under /v2; /v1 routes are frozen and only take security fixes.",
  "Feature flags live in config/flags.yaml and are read once at boot; a change needs a restart.",
  "Customer data never leaves the eu-west region; analytics exports go through the anonymizer job.",
  "The worker queue retries a job five times with exponential backoff, then parks it in the dead-letter table.",
];

const STALE_COMPONENTS = [
  "Travis CI pipeline", "Heroku review apps", "Grunt asset build", "Mongo session store", "Bower front-end deps",
  "Python 2 export script", "Jenkins nightly job", "Vagrant dev box", "Gulp sprite task", "old Elastic 5 cluster",
  "Memcached page cache", "CoffeeScript admin panel", "Capistrano deploy", "Sidekiq 4 queue", "Node 12 runtime",
  "Webpack 3 config", "Flow type stubs", "Karma browser tests", "Ansible 2.4 playbooks", "Mesos scheduler",
  "Consul 0.9 KV", "Selenium grid", "Rails 4 admin", "Angular 1 dashboard", "Ruby 2.3 cron box",
  "Puppet manifests", "Docker Swarm stack", "Nagios checks", "ZooKeeper locks", "Graphite metrics",
];

function staleTruth(component: string, i: number): string {
  return `Legacy note ${i + 1}: the ${component} needs its credentials rotated by hand every quarter, `
    + `and its config lives in the ops wiki rather than the repo, so check the wiki page before touching it; `
    + `the on-call runbook still links to it from the incident checklist section.`;
}

function claudeProjectDir(home: string, cwd: string): string {
  return path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function iso(base: Date, minutesBefore: number): string {
  return new Date(base.getTime() - minutesBefore * 60_000).toISOString();
}

function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function writeClaudeTranscript(home: string, repo: string, now: Date): void {
  const dir = claudeProjectDir(home, repo);
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: CLAUDE_SESSION, cwd: repo, version: "2.1.0", gitBranch: "main", userType: "external", isSidechain: false };
  let n = 0;
  const user = (minutes: number, text: string) => ({ ...base, type: "user", uuid: `c-u-${++n}`, timestamp: iso(now, minutes), message: { role: "user", content: text } });
  const assistant = (minutes: number, content: unknown[]) => ({ ...base, type: "assistant", uuid: `c-a-${++n}`, timestamp: iso(now, minutes), message: { role: "assistant", model: "claude-opus-5-5", content } });
  const toolResult = (minutes: number, id: string, text: string) => ({ ...base, type: "user", uuid: `c-r-${++n}`, timestamp: iso(now, minutes), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  fs.writeFileSync(path.join(dir, `${CLAUDE_SESSION}.jsonl`), jsonl([
    user(300, "The web app now runs its own dev server on 3000, so the API clashes with it. Move the API dev server to port 4100 and update anything that assumes 3000."),
    assistant(299, [
      { type: "text", text: "I'll move the API dev server from 3000 to 4100. Let me find every place the port is set." },
      { type: "tool_use", id: "toolu_01", name: "Grep", input: { pattern: "3000", path: "." } },
    ]),
    toolResult(298, "toolu_01", "src/server.ts:12:  const port = Number(process.env.PORT ?? 3000);\n.env.example:3:PORT=3000\n" + "x".repeat(4000)),
    assistant(297, [
      { type: "tool_use", id: "toolu_02", name: "Edit", input: { file_path: "src/server.ts", old_string: "3000", new_string: "4100" } },
    ]),
    toolResult(296, "toolu_02", "The file src/server.ts has been updated."),
    assistant(295, [{ type: "text", text: "Done. The API dev server now listens on port 4100 (src/server.ts and .env.example). Port 3000 is the web app's." }]),
    user(290, "Thanks. Run the tests."),
    assistant(289, [{ type: "tool_use", id: "toolu_03", name: "Bash", input: { command: "pnpm test" } }]),
    toolResult(288, "toolu_03", "error: relation \"accounts\" does not exist\n" + "y".repeat(3000)),
    assistant(287, [{ type: "text", text: "The tests failed on a missing table, as usual when migrations have not run. Running `pnpm db:migrate` first." }]),
  ]));
}

function writeCodexTranscript(home: string, repo: string, now: Date): void {
  const day = now.toISOString().slice(0, 10).split("-");
  const dir = path.join(home, ".codex", "sessions", day[0], day[1], day[2]);
  fs.mkdirSync(dir, { recursive: true });
  const started = iso(now, 120);
  const stamp = started.replace(/[:.]/g, "-").slice(0, 19);
  const msg = (minutes: number, role: "user" | "assistant", text: string) => ({
    timestamp: iso(now, minutes), type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
  fs.writeFileSync(path.join(dir, `rollout-${stamp}-${CODEX_SESSION}.jsonl`), jsonl([
    { timestamp: started, type: "session_meta", payload: { id: CODEX_SESSION, timestamp: started, cwd: repo, originator: "codex_cli_rs", cli_version: "0.157.0", source: "cli" } },
    msg(119, "user", "The rate limiter needs a store. Redis is not available in the customer's on-prem install, so we can't use it there."),
    msg(118, "assistant", "Two options: an in-process limiter (wrong across replicas) or Postgres. Postgres advisory locks give us a shared limiter with no new dependency."),
    msg(117, "user", "Decision: drop Redis for the rate limiter and use Postgres advisory locks everywhere, on-prem and cloud alike, so there is one code path."),
    { timestamp: iso(now, 116), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["rg", "redis", "src/"] }), call_id: "call_1" } },
    { timestamp: iso(now, 115), type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "src/ratelimit/redis.ts:1:import Redis from 'ioredis'\n" + "z".repeat(3000) } },
    msg(114, "assistant", "Understood: the rate limiter moves to Postgres advisory locks and the Redis adapter goes away. I'll start with src/ratelimit/."),
  ]));
}

function writeStore(store: string, repo: string, now: Date): { staleTruths: string[]; freshTruths: string[] } {
  const projectDir = path.join(store, EVAL_PROJECT);
  fs.mkdirSync(path.join(store, "global"), { recursive: true });
  fs.mkdirSync(path.join(store, ".runtime"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "reference", "pages"), { recursive: true });
  writeRootManifest(store, { version: 1, installMode: "shared", syncMode: "managed-git" });
  fs.writeFileSync(path.join(projectDir, "phren.project.yaml"), `sourcePath: ${repo}\n`);
  fs.writeFileSync(path.join(projectDir, "summary.md"), `# ${EVAL_PROJECT}\n\nAn HTTP API with a Postgres database, a worker queue and a web front end.\n`);

  fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), [
    `# ${EVAL_PROJECT} Findings`,
    "",
    "## 2026-10-20",
    "",
    `- [pattern] The API dev server listens on port 3000; the web app proxies /api to localhost:3000 <!-- fid:${FIDS.contradicted} --> <!-- created: 2026-10-20 -->`,
    `- [pitfall] Run \`pnpm db:migrate\` before \`pnpm test\`, or the suite fails with missing-table errors <!-- fid:${FIDS.dupA} --> <!-- created: 2026-10-20 -->`,
    "",
    "## 2026-10-28",
    "",
    `- [pitfall] Tests fail with "relation does not exist" unless migrations ran first (pnpm db:migrate) <!-- fid:${FIDS.dupB} --> <!-- created: 2026-10-28 -->`,
    `- [decision] Structured logging uses pino with one child logger per request, keyed by request id <!-- fid:${FIDS.control} --> <!-- created: 2026-10-28 -->`,
    "",
  ].join("\n"));

  const freshTruths = FRESH_TRUTHS;
  const staleTruths = STALE_COMPONENTS.map(staleTruth);
  // upsertCanonical's layout: newest first under "## Truths".
  const lines = [...freshTruths.map((t) => `- ${t} _(added 2026-10-01)_`), ...staleTruths.map((t) => `- ${t} _(added 2026-03-01)_`)];
  fs.writeFileSync(path.join(projectDir, "truths.md"), `# ${EVAL_PROJECT} Truths\n\n## Truths\n\n${lines.join("\n")}\n`);

  // Fresh truths were found by searches this week; stale ones never were.
  fs.writeFileSync(path.join(store, ".runtime", "lookup-events.jsonl"), freshTruths.map((t, i) => JSON.stringify({
    at: iso(now, 60 * 24 * (i + 1)), query: "deploy", project: EVAL_PROJECT, filename: "truths.md", type: "canonical", snippet: t, source: "search",
  })).join("\n") + "\n");
  return { staleTruths, freshTruths };
}

function initRepo(repo: string, now: Date): void {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "server.ts"), "export const port = Number(process.env.PORT ?? 4100);\n");
  try {
    const env = { ...process.env, GIT_AUTHOR_DATE: iso(now, 280), GIT_COMMITTER_DATE: iso(now, 280) };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "add", ".");
    git("-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "-q", "-m", "Move the API dev server to port 4100");
  } catch { /* git is optional for the eval: collect treats a missing log as empty */ }
}

/** Builds the fixture under `root` (an empty directory the caller owns and removes). */
export function buildEvalFixture(root: string, now: Date = EVAL_NOW): EvalFixture {
  const store = path.join(root, "store");
  const home = path.join(root, "home");
  const repo = path.join(root, "src", EVAL_PROJECT);
  fs.mkdirSync(home, { recursive: true });
  initRepo(repo, now);
  const { staleTruths, freshTruths } = writeStore(store, repo, now);
  writeClaudeTranscript(home, repo, now);
  writeCodexTranscript(home, repo, now);
  return { root, store, home, repo, project: EVAL_PROJECT, now, budgetKB: EVAL_BUDGET_KB, staleTruths, freshTruths };
}
