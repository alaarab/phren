#!/usr/bin/env node

/**
 * npm preuninstall hook — clean up hooks and MCP server entries from agent
 * config files so they don't become orphaned when the package is removed
 * via `npm uninstall -g @phren/cli` (bypassing `phren uninstall`).
 *
 * Only removes config/hooks — does NOT touch ~/.phren data.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
const homePath = (...parts) => path.join(home, ...parts);

/** Read JSON, apply mutator, write back. */
function patchJson(filePath, mutator) {
  if (!fs.existsSync(filePath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    mutator(data);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  } catch {
    // best-effort — don't fail the uninstall
  }
}

/** Check if a hook command string belongs to phren. */
function isPhrenCommand(cmd) {
  return (
    cmd.includes("@phren/cli") ||
    cmd.includes("phren/cli") ||
    /\bhook-(prompt|stop|session-start|tool|context)\b/.test(cmd)
  );
}

// ── Claude Code settings.json: remove hooks + MCP server ──
const claudeSettings = homePath(".claude", "settings.json");
patchJson(claudeSettings, (data) => {
  // Remove MCP server
  if (data.mcpServers?.phren) delete data.mcpServers.phren;

  // Remove phren hooks
  if (data.hooks && typeof data.hooks === "object") {
    for (const event of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"]) {
      const entries = data.hooks[event];
      if (!Array.isArray(entries)) continue;
      data.hooks[event] = entries.filter(
        (entry) => !entry.hooks?.some((h) => typeof h.command === "string" && isPhrenCommand(h.command))
      );
      if (data.hooks[event].length === 0) delete data.hooks[event];
    }
    if (Object.keys(data.hooks).length === 0) delete data.hooks;
  }
});

// ── Claude Code ~/.claude.json: remove MCP server ──
const claudeJson = homePath(".claude.json");
patchJson(claudeJson, (data) => {
  if (data.mcpServers?.phren) delete data.mcpServers.phren;
});

// ── VS Code MCP configs ──
const vscodeMcpCandidates = [
  homePath(".vscode-server", "data", "User", "mcp.json"),
  homePath("AppData", "Roaming", "Code", "User", "mcp.json"),
  homePath(".config", "Code", "User", "mcp.json"),
];
for (const mcpFile of vscodeMcpCandidates) {
  patchJson(mcpFile, (data) => {
    // servers array format
    if (Array.isArray(data.servers)) {
      data.servers = data.servers.filter((s) => s.name !== "phren");
    }
    // mcpServers object format
    if (data.mcpServers?.phren) delete data.mcpServers.phren;
  });
}

// ── Cursor MCP config ──
const cursorMcpCandidates = [
  homePath(".cursor", "mcp.json"),
];
for (const mcpFile of cursorMcpCandidates) {
  patchJson(mcpFile, (data) => {
    if (data.mcpServers?.phren) delete data.mcpServers.phren;
  });
}

// ── Cursor hooks ──
const cursorHooks = homePath(".cursor", "hooks.json");
patchJson(cursorHooks, (data) => {
  for (const key of ["sessionStart", "beforeSubmitPrompt", "stop"]) {
    if (data[key]?.command && typeof data[key].command === "string" && isPhrenCommand(data[key].command)) {
      delete data[key];
    }
  }
});

// ── Copilot hooks ──
const copilotHooks = homePath(".github", "hooks", "phren.json");
if (fs.existsSync(copilotHooks)) {
  try { fs.unlinkSync(copilotHooks); } catch { /* best-effort */ }
}

console.log("phren: cleaned up hooks and MCP config from agent settings.");
