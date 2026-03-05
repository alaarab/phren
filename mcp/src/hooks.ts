import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

export function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
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

// tools param accepts either a pre-computed Set (from link) or a boolean (from init)
export function configureAllHooks(cortexPath: string, tools: Set<string> | boolean = false): string[] {
  const configured: string[] = [];
  const detected: Set<string> =
    tools instanceof Set ? tools :
    tools ? new Set(["copilot", "cursor", "codex"]) :
    detectInstalledTools();

  const pullCmd = `cd "${cortexPath}" && (git pull --rebase --quiet 2>/dev/null || true) && (npx @alaarab/cortex doctor --fix >/dev/null 2>&1 || true)`;
  const promptCmd = `npx @alaarab/cortex hook-prompt`;
  const stopCmd = `cd "${cortexPath}" && git diff --quiet 2>/dev/null || (git add -A && git commit -m 'auto-save cortex' && git push 2>/dev/null || true)`;

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
        // Cursor has no sessionStart hook; best effort is beforeSubmitPrompt + stop
        beforeSubmitPrompt: { command: promptCmd },
        stop: { command: stopCmd },
      };
      fs.writeFileSync(cursorFile, JSON.stringify(config, null, 2));
      configured.push("Cursor");
    } catch { /* best effort */ }
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
  }

  return configured;
}
