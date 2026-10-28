// Helper runs: one short headless Claude Code run (`claude -p`) for a lead agent, under the project's helper
// account and model, in the lead's folder. Lets a lead on a subscription hand small tasks to a cheaper model
// billed to another login (an API credit), which Claude Code's own subagents can't do: they always run under the
// lead's login. Opt-in per project; see docs/accounts.md.
//
//   phren.project.yaml:  helper: { account: <Claude account id>, model: haiku }
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readProjectConfig } from "../project-config.js";
import { accountPolicy, poolAllowed, projectAllowedPools } from "./account-pools.js";
import { claudeHome, claudeLaunchEnv, isAccountSlug, type ClaudeHome } from "./claude-accounts.js";
import { recordSessionCost } from "./claude-credits.js";
import { DISPATCH_ID_ENV } from "./launch-brief.js";
import { bridgeRoot, object } from "./protocol.js";

export const DEFAULT_HELPER_MODEL = "haiku";
export const HELPER_TIMEOUT_DEFAULT_S = 120;
export const HELPER_TIMEOUT_MAX_S = 600;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9.:_[\]-]{0,63}$/;
const OUTPUT_MAX = 64 * 1024;
/** Claude's JSON answer is kept whole up to this, so a long reply is cut after parsing, not mid-JSON. */
const STDOUT_MAX = 4 * 1024 * 1024;
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_LINES = 1000;
/** Variables that would make the helper sign in, bill or route as something other than its account's own login. */
const ACCOUNT_ENV = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
/** Variables that tie a process to the lead's pane or dispatch, so the helper's own hooks would report as the lead. */
const PANE_ENV = (name: string) => name.startsWith("HERDR_") || name === "TMUX" || name === "TMUX_PANE" || name === DISPATCH_ID_ENV;
/** Without allowEdits: tools that change files or run commands, refused even if a settings file allows them. */
const WRITE_TOOLS = "Bash,Edit,MultiEdit,Write,NotebookEdit";

export interface HelperChoice { project: string; account: string; model: string; home: ClaudeHome; pool?: string }

/**
 * The project's helper account and model, checked: configured, an account on this computer with role `helpers`
 * (a team store's phren.project.yaml can name any of the owner's local accounts), and in the project's and this
 * computer's allowed pools. Throws with what to change otherwise.
 */
export function helperFor(phrenPath: string, project: string, env: NodeJS.ProcessEnv = process.env): HelperChoice {
  const raw = readProjectConfig(phrenPath, project).helper;
  const setting = object(raw);
  if (raw === undefined || setting.account === undefined) {
    throw new Error(`Project ${project} has no helper account: set helper: { account: <account>, model: ${DEFAULT_HELPER_MODEL} } in its phren.project.yaml.`);
  }
  const account = setting.account;
  if (typeof account !== "string" || !isAccountSlug(account)) throw new Error(`Project ${project}'s helper.account is not an account name.`);
  if (setting.model !== undefined && (typeof setting.model !== "string" || !MODEL.test(setting.model))) throw new Error(`Project ${project}'s helper.model is not a model name.`);
  const model = typeof setting.model === "string" ? setting.model : DEFAULT_HELPER_MODEL;
  // Homes as this computer has them, not as the lead's own CLAUDE_CONFIG_DIR would make "default".
  const home = claudeHome(account, { ...env, CLAUDE_CONFIG_DIR: "" });
  if (!home) throw new Error(`There is no Claude account "${account}" on this computer (phren bridge accounts lists them).`);
  // Read strictly: an accounts.yaml that can't be read must not turn the refusals off.
  const policy = accountPolicy();
  const { pool, role } = policy.settings[account] ?? {};
  if (role !== "helpers") throw new Error(`Claude account ${account}'s role is ${role ?? "not set"}: a helper runs only under an account with role helpers (phren bridge accounts role ${account} helpers).`);
  const where = pool ? `pool ${pool}` : "no pool";
  const forProject = projectAllowedPools(phrenPath, project);
  if (!poolAllowed(forProject, pool)) throw new Error(`Claude account ${account} (${where}) is not in project ${project}'s allowed pools: ${forProject!.join(", ")}.`);
  const forComputer = policy.allowedPools;
  if (!poolAllowed(forComputer, pool)) throw new Error(`Claude account ${account} (${where}) is not in this computer's allowed pools: ${forComputer!.join(", ")}.`);
  return { project, account, model, home, ...(pool ? { pool } : {}) };
}

/** The helper's environment: the lead's, without anything naming another login, plus the account's home. */
export function helperEnv(home: ClaudeHome, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = Object.fromEntries(Object.entries(env).filter(([name]) => !ACCOUNT_ENV.includes(name) && !PANE_ENV(name)));
  return { ...next, ...claudeLaunchEnv(home), NO_COLOR: "1" };
}

export interface HelperTokens { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

/** `usage` from Claude's JSON answer as counts, or undefined when it printed none. */
function tokensOf(raw: unknown): HelperTokens | undefined {
  const usage = object(raw);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const tokens: HelperTokens = {};
  const set = (key: keyof HelperTokens, value: unknown) => { const n = count(value); if (n !== undefined) tokens[key] = n; };
  set("input", usage.input_tokens); set("output", usage.output_tokens);
  set("cacheRead", usage.cache_read_input_tokens); set("cacheWrite", usage.cache_creation_input_tokens);
  return Object.keys(tokens).length ? tokens : undefined;
}

export interface HelperResult {
  ok: boolean;
  /** Claude's final reply, or what went wrong; capped at 64 KB. */
  output: string;
  project: string;
  account: string;
  model: string;
  durationMs: number;
  costUSD?: number;
  /** Token counts, when Claude printed them (`usage` in its JSON answer). */
  tokens?: HelperTokens;
  sessionId?: string;
  timedOut?: true;
  truncated?: true;
}

export interface HelperRunOptions {
  prompt: string;
  cwd: string;
  timeoutSeconds?: number;
  /** Let the helper edit files (`--permission-mode acceptEdits`); otherwise tools that need a grant are refused. */
  allowEdits?: boolean;
  env?: NodeJS.ProcessEnv;
  /** The MCP call's cancel: stops the run. */
  signal?: AbortSignal;
  now?: () => number;
}

interface Exit { stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: string }

function runClaude(args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<Exit> {
  return new Promise(resolve => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const windows = process.platform === "win32";
    // Its own process group, so a timeout or cancel also stops what it started.
    const detached = !windows;
    // An npm install on Windows is claude.cmd, which only a shell starts; the arguments are fixed flags and a checked model name.
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached, shell: windows });
    const kill = () => {
      try { if (detached && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already gone. */ }
    };
    const onAbort = () => kill();
    const finish = (exit: Omit<Exit, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, timedOut, ...exit });
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    if (signal?.aborted) kill(); else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < STDOUT_MAX) stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < OUTPUT_MAX) stderr += chunk; });
    child.on("error", error => finish({ code: null, spawnError: (error as NodeJS.ErrnoException).code === "ENOENT" ? "claude is not on this computer's PATH." : error.message }));
    child.on("close", code => finish({ code }));
    child.stdin.on("error", () => { /* The child exited before reading its prompt. */ });
    child.stdin.end(input);
  });
}

const cap = (text: string): { text: string; truncated?: true } =>
  text.length > OUTPUT_MAX ? { text: `${text.slice(0, OUTPUT_MAX)}\n[output cut at 64 KB]`, truncated: true } : { text };

/** Run one helper task and record it. Never throws for the run itself: a failed run is `ok: false`. */
export async function runHelper(choice: HelperChoice, options: HelperRunOptions): Promise<HelperResult> {
  const now = options.now ?? Date.now;
  const seconds = Math.min(HELPER_TIMEOUT_MAX_S, Math.max(1, Math.round(options.timeoutSeconds ?? HELPER_TIMEOUT_DEFAULT_S)));
  // No MCP servers from the account or the folder; read-only means the write tools are refused outright, whatever
  // a settings file allows.
  const args = ["-p", "--model", choice.model, "--output-format", "json", "--strict-mcp-config",
    ...(options.allowEdits ? ["--permission-mode", "acceptEdits"] : ["--permission-mode", "default", "--disallowedTools", WRITE_TOOLS])];
  const started = now();
  const exit = await runClaude(args, options.prompt, options.cwd, helperEnv(choice.home, options.env), seconds * 1000, options.signal);
  const durationMs = Math.max(0, now() - started);
  const base = { project: choice.project, account: choice.account, model: choice.model, durationMs };
  let result: HelperResult;
  if (exit.spawnError) {
    result = { ...base, ok: false, output: exit.spawnError };
  } else {
    let parsed: Record<string, unknown> | undefined;
    try { const value = JSON.parse(exit.stdout); if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>; } catch { /* Not Claude's JSON. */ }
    const reply = typeof parsed?.result === "string" ? parsed.result : undefined;
    const cost = typeof parsed?.total_cost_usd === "number" && Number.isFinite(parsed.total_cost_usd) && parsed.total_cost_usd >= 0 ? parsed.total_cost_usd : undefined;
    const sessionId = typeof parsed?.session_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(parsed.session_id) ? parsed.session_id : undefined;
    const cancelled = options.signal?.aborted === true;
    const failed = cancelled || exit.timedOut || exit.code !== 0 || parsed?.is_error === true || reply === undefined;
    const text = cancelled ? "The helper was cancelled." : exit.timedOut ? `The helper ran past ${seconds}s and was stopped.${reply ? `\n${reply}` : ""}`
      : reply ?? (exit.stderr.trim() || exit.stdout.trim() || `claude exited with ${exit.code ?? "a signal"} and no reply.`);
    const output = cap(text);
    result = { ...base, ok: !failed, output: output.text, ...(output.truncated ? { truncated: true as const } : {}),
      ...(cost !== undefined ? { costUSD: cost } : {}), ...(tokensOf(parsed?.usage) ? { tokens: tokensOf(parsed?.usage) } : {}),
      ...(sessionId ? { sessionId } : {}), ...(exit.timedOut ? { timedOut: true as const } : {}) };
    // The spend counts against the account's entered API credits, like its interactive sessions.
    if (sessionId && cost !== undefined) await recordSessionCost(choice.home, { session_id: sessionId, cost: { total_cost_usd: cost } }, new Date(now())).catch(() => undefined);
  }
  recordHelperRun(result, new Date(now()));
  return result;
}

/** `<bridge>/usage/helper-runs.jsonl`: one line per run (when, project, account, model, outcome, cost), never the prompt. */
export const helperRunsFile = () => path.join(bridgeRoot(), "usage", "helper-runs.jsonl");

function recordHelperRun(result: HelperResult, at: Date): void {
  const file = helperRunsFile();
  const line = JSON.stringify({ at: at.toISOString(), project: result.project, account: result.account, model: result.model, ok: result.ok,
    durationMs: result.durationMs, ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}), ...(result.tokens ? { tokens: result.tokens } : {}),
    ...(result.timedOut ? { timedOut: true } : {}) });
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    if (statSync(file).size > LOG_MAX_BYTES) {
      const kept = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-LOG_KEEP_LINES);
      writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
    }
  } catch { /* The run's answer matters more than its log line. */ }
}
