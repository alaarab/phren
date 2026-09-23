// The user's home and the agent config directories under it. Node builtins
// only: the Hook bundle reads these on cold start.
import { homedir } from "node:os";
import path from "node:path";

/** The user's home: an absolute `HOME` when set (tests and POSIX), else
 * `USERPROFILE`, else the OS's answer. `os.homedir()` ignores `HOME` on Windows. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME && path.isAbsolute(env.HOME) ? env.HOME : env.USERPROFILE || homedir();
}

function configuredDir(value: string | undefined, env: NodeJS.ProcessEnv, fallback: string): string {
  const configured = value?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir(env), fallback);
}

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return configuredDir(env.CLAUDE_CONFIG_DIR, env, ".claude");
}

/** Codex's home: `CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return configuredDir(env.CODEX_HOME, env, ".codex");
}
