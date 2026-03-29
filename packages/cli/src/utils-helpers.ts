import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { bootstrapPhrenDotEnv } from "./phren-dotenv.js";

// ── Shared Git helper ────────────────────────────────────────────────────────

export function runGitOrThrow(cwd: string, args: string[], timeoutMs: number): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const suffix = stderr ? `: ${stderr}` : result.signal ? ` (signal: ${result.signal})` : "";
    throw new Error(`git ${args.join(" ")} exited with status ${result.status ?? "unknown"}${suffix}`);
  }
  return result.stdout ?? "";
}

export function runGit(cwd: string, args: string[], timeoutMs: number, debugLogFn?: (msg: string) => void): string | null {
  try {
    return runGitOrThrow(cwd, args, timeoutMs).trim();
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (debugLogFn) debugLogFn(`runGit: git ${args[0]} failed in ${cwd}: ${msg}`);
    return null;
  }
}

interface ResolvedExecCommand {
  command: string;
  shell: boolean;
}

function needsCommandShell(cmd: string): boolean {
  return /\.(cmd|bat)$/i.test(path.basename(cmd));
}

export function normalizeExecCommand(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  whereOutput?: string | null,
): ResolvedExecCommand {
  if (platform !== "win32") return { command: cmd, shell: false };

  if (cmd.includes("\\") || cmd.includes("/") || /\.[A-Za-z0-9]+$/i.test(path.basename(cmd))) {
    return { command: cmd, shell: needsCommandShell(cmd) };
  }

  const candidate = (whereOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const resolved = candidate || cmd;
  return { command: resolved, shell: needsCommandShell(resolved) };
}

export function resolveExecCommand(cmd: string): ResolvedExecCommand {
  if (process.platform !== "win32") return { command: cmd, shell: false };
  try {
    const whereOutput = execFileSync("where.exe", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return normalizeExecCommand(cmd, process.platform, whereOutput);
  } catch {
    return normalizeExecCommand(cmd, process.platform, null);
  }
}

// ── Error message extractor ─────────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Feature flag and clamping helpers ────────────────────────────────────────

export function isFeatureEnabled(envName: string, defaultValue: boolean = true): boolean {
  bootstrapPhrenDotEnv();
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
