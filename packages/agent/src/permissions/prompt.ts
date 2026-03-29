/**
 * Smart permission prompt — themed, color-coded, full context, keyboard shortcuts.
 *
 * Responses:
 *   y = allow once
 *   n = deny
 *   a = allow this tool for the rest of the session (any input)
 *   s = allow this exact tool+pattern for the rest of the session
 */

import * as readline from "node:readline";
import { addAllow } from "./allowlist.js";
import { t, formatPermissionHeader, formatPermissionBorder, formatPermissionHint } from "../theme.js";

// ── Prompt serialization lock ───────────────────────────────────────────
// Prevents concurrent askUser() calls from interleaving their prompts.
let promptQueue: Promise<void> = Promise.resolve();

// ── Risk classification ─────────────────────────────────────────────────

type Risk = "read" | "write" | "dangerous";

const READ_TOOLS = new Set([
  "read_file", "glob", "grep", "git_status", "git_diff",
  "phren_search", "phren_get_tasks", "web_search",
]);
const DANGEROUS_TOOLS = new Set(["shell"]);

function classifyRisk(toolName: string): Risk {
  if (READ_TOOLS.has(toolName)) return "read";
  if (DANGEROUS_TOOLS.has(toolName)) return "dangerous";
  return "write";
}

// ── Summary generation ──────────────────────────────────────────────────

function summarizeCall(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file": {
      const p = (input.path as string) || "?";
      const offset = input.offset ? ` from line ${input.offset}` : "";
      const limit = input.limit ? ` (${input.limit} lines)` : "";
      return `Read ${p}${offset}${limit}`;
    }
    case "write_file": {
      const p = (input.path as string) || "?";
      const content = (input.content as string) || "";
      const lines = content.split("\n").length;
      return `Write ${lines} lines to ${p}`;
    }
    case "edit_file": {
      const p = (input.path as string) || "?";
      return `Edit ${p}`;
    }
    case "glob": {
      const pattern = (input.pattern as string) || "?";
      const dir = (input.path as string) || ".";
      return `Glob "${pattern}" in ${dir}`;
    }
    case "grep": {
      const pattern = (input.pattern as string) || "?";
      const dir = (input.path as string) || ".";
      return `Grep "${pattern}" in ${dir}`;
    }
    case "shell": {
      const cmd = (input.command as string) || "?";
      return cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
    }
    case "git_commit": {
      const msg = (input.message as string) || "";
      return `Commit: ${msg.slice(0, 80)}`;
    }
    case "phren_add_finding":
      return `Save finding to phren`;
    case "phren_complete_task":
      return `Complete phren task`;
    case "phren_add_task":
      return `Add phren task`;
    case "subagent":
      return `Spawn subagent: ${((input.task as string) || "").slice(0, 80)}`;
    case "web_search":
      return `Search: ${(input.query as string) || "?"}`;
    case "lsp":
      return `LSP ${input.action}: ${(input.file as string) || "?"}:${input.line}`;
    default: {
      const keys = Object.keys(input);
      return keys.length > 0 ? `${toolName}(${keys.join(", ")})` : toolName;
    }
  }
}

// ── Main prompt ─────────────────────────────────────────────────────────

export type PromptResult = "allow" | "deny" | "allow-session" | "allow-tool";

/**
 * Ask the user on stderr whether to allow a tool call.
 * Returns true if user approves (y, a, or s), false if denied (n).
 *
 * Side effect: "a" and "s" responses add to the session allowlist.
 */
export async function askUser(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): Promise<boolean> {
  // Serialize: wait for any prior prompt to finish before showing ours
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  const previous = promptQueue;
  promptQueue = gate;
  await previous;

  try {
    const risk = classifyRisk(toolName);
    const summary = summarizeCall(toolName, input);

    // Themed header with risk badge
    process.stderr.write(formatPermissionBorder() + "\n");
    process.stderr.write(formatPermissionHeader(risk, toolName) + "\n");
    process.stderr.write(`${t.muted(`  ${reason}`)}\n`);
    process.stderr.write(`${t.info(`  ${summary}`)}\n`);

    // Show full input for shell commands or when details matter
    if (toolName === "shell") {
      const cmd = (input.command as string) || "";
      if (cmd.length > 120) {
        process.stderr.write(`${t.muted("  Full command:")}\n`);
        process.stderr.write(`${t.command(`  ${cmd}`)}\n`);
      }
    }

    process.stderr.write(formatPermissionBorder() + "\n");

    const result = await promptKey();

    // Persist allowlist entries for session/tool scopes
    if (result === "allow-session") {
      addAllow(toolName, input, "session");
    } else if (result === "allow-tool") {
      addAllow(toolName, input, "tool");
    }

    return result !== "deny";
  } finally {
    resolve();
  }
}

/**
 * Read a single keypress from stdin.
 * Temporarily exits raw mode if the TUI has it enabled, restores after.
 */
async function promptKey(): Promise<PromptResult> {
  process.stderr.write(formatPermissionHint());

  const wasRaw = process.stdin.isTTY && (process.stdin as NodeJS.ReadStream).isRaw;

  return new Promise<PromptResult>((resolve) => {
    if (process.stdin.isTTY) {
      // Single-keypress mode
      if (!wasRaw) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      const onData = (data: Buffer) => {
        process.stdin.removeListener("data", onData);
        if (!wasRaw && process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();

        const key = data.toString().trim().toLowerCase();

        // Echo the choice with color
        switch (key) {
          case "y":
            process.stderr.write(t.success("yes") + "\n");
            resolve("allow");
            break;
          case "a":
            process.stderr.write(t.success("allow-tool") + "\n");
            resolve("allow-tool");
            break;
          case "s":
            process.stderr.write(t.success("session-allow") + "\n");
            resolve("allow-session");
            break;
          case "n":
            process.stderr.write(t.error("denied") + "\n");
            resolve("deny");
            break;
          case "\x03": // Ctrl+C
            process.stderr.write(t.error("denied") + "\n");
            resolve("deny");
            break;
          default:
            process.stderr.write(t.error("denied (unknown key)") + "\n");
            resolve("deny"); // Unknown key = deny (safe default)
        }
      };

      process.stdin.on("data", onData);
    } else {
      // Non-TTY fallback: readline
      const iface = readline.createInterface({ input: process.stdin, output: process.stderr });
      iface.question("", (answer: string) => {
        iface.close();
        const key = answer.trim().toLowerCase();
        switch (key) {
          case "y": resolve("allow"); break;
          case "a": resolve("allow-tool"); break;
          case "s": resolve("allow-session"); break;
          default: resolve("deny");
        }
      });
    }
  });
}
