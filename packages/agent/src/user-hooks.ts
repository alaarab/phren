import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentConfigDir, agentUserDir } from "./config.js";

export type HookEventName = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart" | "PreCompact";

export interface HookCommand {
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export type HooksConfig = Partial<Record<HookEventName, HookCommand[]>>;

export interface HookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HookRunOptions {
  cwd?: string;
  executor?: HookExecutor;
  timeoutMs?: number;
}

export type HookExecutor = (
  command: string,
  stdin: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<HookRunResult>;

export interface HookDenial {
  denied: boolean;
  message: string;
}

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "PreCompact",
];

/**
 * What lifecycle hooks said, in Claude Code's convention: exit code 2 blocks
 * (the prompt for UserPromptSubmit, stopping for Stop) with stderr as the
 * reason; exit 0 stdout is context for UserPromptSubmit and SessionStart.
 * Any other result is ignored, so a broken hook never stops the agent.
 */
export interface LifecycleHookResult {
  blocked: boolean;
  /** stderr of the blocking hook. */
  reason: string;
  /** stdout of the hooks that exited 0, joined. */
  context: string;
}

/** Exit code that blocks, as in Claude Code. */
export const BLOCKING_EXIT_CODE = 2;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 16_384;

function isHookCommand(value: unknown): value is HookCommand {
  return !!value && typeof value === "object" && typeof (value as { command?: unknown }).command === "string";
}

function readHooksFile(file: string): HooksConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { hooks?: unknown };
    const hooks = parsed?.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
    const out: HooksConfig = {};
    let found = false;
    for (const event of HOOK_EVENT_NAMES) {
      const list = (hooks as Record<string, unknown>)[event];
      if (!Array.isArray(list)) continue;
      const commands = list.filter(isHookCommand);
      if (commands.length === 0) continue;
      out[event] = commands;
      found = true;
    }
    return found ? out : null;
  } catch {
    return null;
  }
}

export function loadHooksConfig(cwd = process.cwd(), options: { home?: string } = {}): HooksConfig | null {
  const userFile = path.join(agentUserDir(options.home), "hooks.json");
  const projectFile = path.join(agentConfigDir(cwd), "hooks.json");
  const merged: HooksConfig = {};
  let found = false;
  for (const file of [userFile, projectFile]) {
    const cfg = readHooksFile(file);
    if (!cfg) continue;
    found = true;
    for (const event of HOOK_EVENT_NAMES) {
      const list = cfg[event];
      if (!list) continue;
      merged[event] = [...(merged[event] ?? []), ...list];
    }
  }
  return found ? merged : null;
}

function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function capOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
}

function defaultHookExecutor(
  command: string,
  stdin: string,
  options: { cwd: string; timeoutMs: number },
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: unknown) {
      resolve({ exitCode: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: capOutput(stdout), stderr: capOutput(stderr), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { }
      finish(null);
    }, options.timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err: Error) => { stderr += err.message; finish(null); });
    child.on("close", (code: number | null) => { finish(code); });
    child.stdin?.on("error", () => { });
    child.stdin?.end(stdin);
  });
}

async function runHook(
  hook: HookCommand,
  payload: Record<string, unknown>,
  options: HookRunOptions,
): Promise<HookRunResult> {
  const executor = options.executor ?? defaultHookExecutor;
  const timeoutMs = options.timeoutMs ?? hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await executor(hook.command, JSON.stringify(payload), {
      cwd: options.cwd ?? process.cwd(),
      timeoutMs,
    });
  } catch (err: unknown) {
    return {
      exitCode: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
}

export async function runPreToolUseHooks(
  config: HooksConfig | null,
  toolName: string,
  input: Record<string, unknown>,
  options: HookRunOptions = {},
): Promise<HookDenial> {
  const hooks = (config?.PreToolUse ?? []).filter((hook) => matchesTool(hook.matcher, toolName));
  if (hooks.length === 0) return { denied: false, message: "" };
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: input,
    cwd: options.cwd ?? process.cwd(),
  };
  for (const hook of hooks) {
    const result = await runHook(hook, payload, options);
    if (result.exitCode !== null && result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `Blocked by PreToolUse hook: ${hook.command}`;
      return { denied: true, message };
    }
  }
  return { denied: false, message: "" };
}

/**
 * PostToolUse hooks run after the tool; one that exits 2 sends its stderr back
 * to the model with the tool's result (a formatter or linter complaining).
 * Returns that feedback, or "".
 */
export async function runPostToolUseHooks(
  config: HooksConfig | null,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  options: HookRunOptions = {},
): Promise<string> {
  const hooks = (config?.PostToolUse ?? []).filter((hook) => matchesTool(hook.matcher, toolName));
  if (hooks.length === 0) return "";
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: input,
    tool_response: output,
    is_error: isError,
    cwd: options.cwd ?? process.cwd(),
  };
  const feedback: string[] = [];
  for (const hook of hooks) {
    const result = await runHook(hook, payload, options);
    if (result.exitCode === BLOCKING_EXIT_CODE && result.stderr.trim()) feedback.push(result.stderr.trim());
  }
  return feedback.join("\n");
}

export async function runLifecycleHooks(
  config: HooksConfig | null,
  event: "UserPromptSubmit" | "Stop" | "SessionStart" | "PreCompact",
  payload: Record<string, unknown> = {},
  options: HookRunOptions = {},
): Promise<LifecycleHookResult> {
  const hooks = config?.[event] ?? [];
  const outcome: LifecycleHookResult = { blocked: false, reason: "", context: "" };
  if (hooks.length === 0) return outcome;
  const body = { hook_event_name: event, ...payload, cwd: options.cwd ?? process.cwd() };
  const context: string[] = [];
  for (const hook of hooks) {
    const result = await runHook(hook, body, options);
    if (result.exitCode === BLOCKING_EXIT_CODE) {
      return { blocked: true, reason: result.stderr.trim() || `Blocked by ${event} hook: ${hook.command}`, context: context.join("\n") };
    }
    if (result.exitCode === 0 && result.stdout.trim()) context.push(result.stdout.trim());
  }
  outcome.context = context.join("\n");
  return outcome;
}
