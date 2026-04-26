/**
 * Guards against `phren init` silently repointing the user's global wiring
 * (CLI wrapper at ~/.local/bin/phren and Claude settings.json hooks/MCP) at a
 * different phren root than the one currently in use.
 *
 * Why: `phren init` is also exercised by tests/smoke scripts that invoke it
 * with `PHREN_PATH=/tmp/...`. Without an isolated $HOME the install logic
 * cheerfully rewrites the user's real wrapper and Claude hooks to point at
 * the throwaway path, which then disappears with `rm -rf /tmp/foo`. The next
 * Claude session boots with a SessionStart hook that throws
 *   `NOT_FOUND: phren root not found. Run 'phren init'.`
 *
 * Behavior: before any global file is rewritten, scan the three known
 * locations. If any of them already references a *different* path that
 * resolves to a valid phren root, refuse to proceed unless `--force` is
 * passed. Stale wiring (existing path missing or not a phren root) is not a
 * conflict — init is the right tool to repair it.
 */
import * as fs from "fs";
import * as path from "path";
import { homePath, isRecord } from "../shared.js";
import { hookConfigPath } from "../provider-adapters.js";

export interface WiringConflict {
  location: string;
  existingPath: string;
}

const WRAPPER_POSIX_RE = /PHREN_PATH="\$\{PHREN_PATH:-([^}]+)\}"/;
const WRAPPER_WIN_RE = /set "PHREN_PATH=([^"]+)"/;
const HOOK_PHREN_PATH_RE = /PHREN_PATH=(?:'([^']+)'|"([^"]+)"|(\S+))/;

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * A path counts as a "valid phren root" only if it currently looks like one
 * — root manifest, machines.yaml, or the global skills tree. We deliberately
 * tolerate partial roots so a clean `phren init` repair still works.
 */
function looksLikePhrenRoot(candidate: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  if (fs.existsSync(path.join(candidate, "phren.root.yaml"))) return true;
  if (fs.existsSync(path.join(candidate, "machines.yaml"))) return true;
  if (fs.existsSync(path.join(candidate, "global"))) return true;
  return false;
}

function readWrapperPath(): string | null {
  const wrapperName = process.platform === "win32" ? "phren.cmd" : "phren";
  const wrapperFile = path.join(homePath(".local", "bin"), wrapperName);
  if (!fs.existsSync(wrapperFile)) return null;
  let content: string;
  try {
    content = fs.readFileSync(wrapperFile, "utf8");
  } catch {
    return null;
  }
  if (!content.includes("PHREN_CLI_WRAPPER")) return null;
  const re = process.platform === "win32" ? WRAPPER_WIN_RE : WRAPPER_POSIX_RE;
  const m = content.match(re);
  return m?.[1] ?? null;
}

function extractHookPhrenPath(command: string): string | null {
  const m = command.match(HOOK_PHREN_PATH_RE);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function readClaudeSettings(): unknown {
  const settingsPath = hookConfigPath("claude");
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

export function findConflictingGlobalWiring(newPhrenPath: string): WiringConflict[] {
  const conflicts: WiringConflict[] = [];
  const seen = new Set<string>();
  const record = (location: string, existingPath: string) => {
    if (samePath(existingPath, newPhrenPath)) return;
    if (!looksLikePhrenRoot(existingPath)) return;
    const key = `${location}:${path.resolve(existingPath)}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({ location, existingPath });
  };

  const wrapperPath = readWrapperPath();
  if (wrapperPath) {
    record(`~/.local/bin/${process.platform === "win32" ? "phren.cmd" : "phren"} wrapper`, wrapperPath);
  }

  const settings = readClaudeSettings();
  if (isRecord(settings)) {
    const mcpServers = settings.mcpServers;
    if (isRecord(mcpServers)) {
      const phrenServer = mcpServers.phren;
      if (isRecord(phrenServer) && Array.isArray(phrenServer.args) && phrenServer.args.length > 0) {
        const last = phrenServer.args[phrenServer.args.length - 1];
        if (typeof last === "string") {
          record("~/.claude/settings.json mcpServers.phren", last);
        }
      }
    }

    const hooks = settings.hooks;
    if (isRecord(hooks)) {
      for (const eventName of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const) {
        const eventHooks = hooks[eventName];
        if (!Array.isArray(eventHooks)) continue;
        for (const entry of eventHooks) {
          if (!isRecord(entry)) continue;
          const inner = entry.hooks;
          if (!Array.isArray(inner)) continue;
          for (const h of inner) {
            if (!isRecord(h)) continue;
            const command = typeof h.command === "string" ? h.command : "";
            if (!command) continue;
            const extracted = extractHookPhrenPath(command);
            if (extracted) {
              record(`~/.claude/settings.json hooks.${eventName}`, extracted);
            }
          }
        }
      }
    }
  }

  return conflicts;
}

export function assertNoGlobalWiringConflict(newPhrenPath: string, force: boolean): void {
  if (force) return;
  const conflicts = findConflictingGlobalWiring(newPhrenPath);
  if (conflicts.length === 0) return;
  const lines: string[] = [
    `phren init: refusing to repoint global wiring at ${newPhrenPath}.`,
    "",
    "Existing files reference a different phren root that still looks valid:",
  ];
  for (const c of conflicts) {
    lines.push(`  - ${c.location} → ${c.existingPath}`);
  }
  lines.push("");
  lines.push("If you intend to switch the global wiring to the new path, re-run with --force.");
  lines.push("If you're running a smoke test, set HOME (and XDG_*) to a sandbox before invoking init.");
  throw new Error(lines.join("\n"));
}
