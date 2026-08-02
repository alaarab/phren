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
 * Behavior: before any global file is rewritten, scan the known locations. If
 * any of them already references a *different* path that resolves to a valid
 * phren root, refuse to proceed unless `--force` is passed. Stale wiring
 * (existing path missing or not a phren root) is not a conflict — init is the
 * right tool to repair it.
 *
 * Scope, stated precisely because the module name reads broader than it is:
 * this guards `phren init` only, and only the four locations enumerated in
 * findConflictingGlobalWiring — the CLI wrapper, settings.json mcpServers,
 * settings.json hooks, and (added later) the ~/.claude/CLAUDE.md symlink.
 *
 * It is NOT a guard on every user-level file phren writes. In particular the
 * home skill symlinks under ~/.claude/skills are not covered, and
 * `repairPreexistingInstall()` — which rewrites the same global surfaces and
 * runs on every SessionStart hook, from the web UI, and from `phren doctor` —
 * never calls into this module at all. The CLAUDE.md symlink case is handled
 * at its own write site in init/setup.ts (repairGlobalClaudeSymlink) using the
 * helpers exported here, so it holds on those paths too.
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
export function looksLikePhrenRoot(candidate: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  if (fs.existsSync(path.join(candidate, "phren.root.yaml"))) return true;
  if (fs.existsSync(path.join(candidate, "machines.yaml"))) return true;
  if (fs.existsSync(path.join(candidate, "global"))) return true;
  return false;
}

/**
 * True when `candidate` is a *different* phren root than the one being
 * installed and still looks live. That combination is the one case where
 * rewriting a global file destroys wiring someone is actually using; a stale
 * root (deleted, or never a root) is exactly what init exists to repair.
 */
export function isLiveForeignPhrenRoot(candidate: string, newPhrenPath: string): boolean {
  if (samePath(candidate, newPhrenPath)) return false;
  return looksLikePhrenRoot(candidate);
}

/**
 * Recover the phren root that owns a `~/.claude/CLAUDE.md` symlink, from the
 * link target's shape (`<root>/global/CLAUDE.md`). Returns null when the
 * target is not structured like a phren global file, i.e. it belongs to
 * something that is not phren and must not be touched.
 */
export function phrenRootFromGlobalClaudeLink(target: string): string | null {
  const resolved = path.resolve(target);
  if (path.basename(resolved) !== "CLAUDE.md") return null;
  const globalDir = path.dirname(resolved);
  if (path.basename(globalDir) !== "global") return null;
  const root = path.dirname(globalDir);
  return root && root !== globalDir ? root : null;
}

/**
 * The phren root that `~/.claude/CLAUDE.md` currently points at, or null when
 * the file is absent, a regular file, or a symlink into something that isn't
 * a phren store.
 */
function readGlobalClaudeMdRoot(): string | null {
  const dest = homePath(".claude", "CLAUDE.md");
  let target: string;
  try {
    if (!fs.lstatSync(dest).isSymbolicLink()) return null;
    target = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
  } catch {
    return null;
  }
  return phrenRootFromGlobalClaudeLink(target);
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

  // ~/.claude/CLAUDE.md is a symlink into <root>/global/CLAUDE.md, i.e. it is
  // global wiring exactly like the wrapper is — but it was not scanned, so
  // `phren init` with a throwaway PHREN_PATH would repoint the user's real one
  // and the guard would report no conflict.
  const claudeMdRoot = readGlobalClaudeMdRoot();
  if (claudeMdRoot) {
    record("~/.claude/CLAUDE.md symlink", claudeMdRoot);
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
