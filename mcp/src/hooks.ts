import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

export function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch { return false; }
}

export function detectInstalledTools(): Set<string> {
  const tools = new Set<string>();
  if (commandExists("gh") || fs.existsSync(path.join(os.homedir(), ".github"))) {
    tools.add("copilot");
  }
  if (commandExists("cursor") || fs.existsSync(path.join(os.homedir(), ".cursor"))) {
    tools.add("cursor");
  }
  if (commandExists("codex") || fs.existsSync(path.join(os.homedir(), ".codex"))) {
    tools.add("codex");
  }
  return tools;
}

function resolveToolBinary(tool: string): string | null {
  try {
    const wrapperPath = path.resolve(path.join(os.homedir(), ".local", "bin", tool));
    const raw = execFileSync("which", ["-a", tool], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const candidates = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (resolved !== wrapperPath) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveCliEntryScript(): string | null {
  const local = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  return fs.existsSync(local) ? local : null;
}

export interface LifecycleCommands {
  sessionStart: string;
  userPromptSubmit: string;
  stop: string;
}

export function buildLifecycleCommands(cortexPath: string): LifecycleCommands {
  const entry = resolveCliEntryScript();
  if (entry) {
    const escapedEntry = entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      sessionStart: `CORTEX_PATH="${escapedCortex}" node "${escapedEntry}" hook-session-start`,
      userPromptSubmit: `CORTEX_PATH="${escapedCortex}" node "${escapedEntry}" hook-prompt`,
      stop: `CORTEX_PATH="${escapedCortex}" node "${escapedEntry}" hook-stop`,
    };
  }

  const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return {
    sessionStart: `CORTEX_PATH="${escapedCortex}" npx @alaarab/cortex hook-session-start`,
    userPromptSubmit: `CORTEX_PATH="${escapedCortex}" npx @alaarab/cortex hook-prompt`,
    stop: `CORTEX_PATH="${escapedCortex}" npx @alaarab/cortex hook-stop`,
  };
}

function installSessionWrapper(tool: string, cortexPath: string): boolean {
  const realBinary = resolveToolBinary(tool);
  if (!realBinary) return false;

  const entry = resolveCliEntryScript();

  const localBinDir = path.join(os.homedir(), ".local", "bin");
  const wrapperPath = path.join(localBinDir, tool);

  const escapedBinary = realBinary.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedEntry = entry ? entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : "";
  const sessionStartCmd = entry
    ? `env CORTEX_PATH="$CORTEX_PATH" node "$ENTRY_SCRIPT" hook-session-start`
    : `env CORTEX_PATH="$CORTEX_PATH" npx @alaarab/cortex hook-session-start`;
  const stopCmd = entry
    ? `env CORTEX_PATH="$CORTEX_PATH" node "$ENTRY_SCRIPT" hook-stop`
    : `env CORTEX_PATH="$CORTEX_PATH" npx @alaarab/cortex hook-stop`;
  const content = `#!/usr/bin/env bash
set -u

REAL_BIN="${escapedBinary}"
CORTEX_PATH="\${CORTEX_PATH:-${escapedCortex}}"
ENTRY_SCRIPT="${escapedEntry}"

if [ ! -x "$REAL_BIN" ]; then
  echo "cortex wrapper error: real ${tool} binary not executable: $REAL_BIN" >&2
  exit 127
fi

case "\${1:-}" in
  -h|--help|help|-V|--version|version|completion)
    exec "$REAL_BIN" "$@"
    ;;
esac

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$1" "\${@:2}" || true
  else
    "\${@:2}" || true
  fi
}

run_with_timeout 14s ${sessionStartCmd} >/dev/null 2>&1

"$REAL_BIN" "$@"
status=$?

run_with_timeout 14s ${stopCmd} >/dev/null 2>&1

exit $status
`;

  try {
    fs.mkdirSync(localBinDir, { recursive: true });
    fs.writeFileSync(wrapperPath, content);
    fs.chmodSync(wrapperPath, 0o755);
    return true;
  } catch {
    return false;
  }
}

// tools param accepts either a pre-computed Set (from link) or a boolean (from init)
export function configureAllHooks(cortexPath: string, tools: Set<string> | boolean = false): string[] {
  const configured: string[] = [];
  const detected: Set<string> =
    tools instanceof Set ? tools :
    tools ? new Set(["copilot", "cursor", "codex"]) :
    detectInstalledTools();

  const lifecycle = buildLifecycleCommands(cortexPath);
  const pullCmd = lifecycle.sessionStart;
  const promptCmd = lifecycle.userPromptSubmit;
  const stopCmd = lifecycle.stop;

  // ── GitHub Copilot CLI (user-level: ~/.github/hooks/cortex.json) ──────────
  if (detected.has("copilot")) {
    const copilotHooksDir = path.join(os.homedir(), ".github", "hooks");
    const copilotFile = path.join(copilotHooksDir, "cortex.json");
    try {
      fs.mkdirSync(copilotHooksDir, { recursive: true });
      const config = {
        version: 1,
        hooks: {
          sessionStart: [{ type: "command", bash: pullCmd }],
          userPromptSubmitted: [{ type: "command", bash: promptCmd }],
          sessionEnd: [{ type: "command", bash: stopCmd }],
        },
      };
      fs.writeFileSync(copilotFile, JSON.stringify(config, null, 2));
      configured.push("Copilot CLI");
    } catch { /* best effort */ }
    installSessionWrapper("copilot", cortexPath);
  }

  // ── Cursor (user-level: ~/.cursor/hooks.json) ────────────────────────────
  if (detected.has("cursor")) {
    const cursorFile = path.join(os.homedir(), ".cursor", "hooks.json");
    try {
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
      let existing: any = {};
      try { existing = JSON.parse(fs.readFileSync(cursorFile, "utf8")); } catch { /* new file */ }
      const config = {
        ...existing,
        version: 1,
        // Cursor parity: sessionStart is best-effort where supported; wrapper also enforces lifecycle.
        sessionStart: { command: pullCmd },
        beforeSubmitPrompt: { command: promptCmd },
        stop: { command: stopCmd },
      };
      fs.writeFileSync(cursorFile, JSON.stringify(config, null, 2));
      configured.push("Cursor");
    } catch { /* best effort */ }
    installSessionWrapper("cursor", cortexPath);
  }

  // ── Codex (codex.json in cortex path) ────────────────────────────────────
  if (detected.has("codex")) {
    const codexFile = path.join(cortexPath, "codex.json");
    try {
      let existing: any = {};
      try { existing = JSON.parse(fs.readFileSync(codexFile, "utf8")); } catch { /* new file */ }
      const config = {
        ...existing,
        hooks: {
          SessionStart: [{ type: "command", command: pullCmd }],
          UserPromptSubmit: [{ type: "command", command: promptCmd }],
          Stop: [{ type: "command", command: stopCmd }],
        },
      };
      fs.writeFileSync(codexFile, JSON.stringify(config, null, 2));
      configured.push("Codex");
    } catch { /* best effort */ }
    installSessionWrapper("codex", cortexPath);
  }

  return configured;
}
