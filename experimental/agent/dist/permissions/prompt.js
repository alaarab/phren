/**
 * Smart permission prompt — color-coded, full context, keyboard shortcuts.
 *
 * Responses:
 *   y = allow once
 *   n = deny
 *   a = allow this tool for the rest of the session (any input)
 *   s = allow this exact tool+pattern for the rest of the session
 */
import * as readline from "node:readline";
import { addAllow } from "./allowlist.js";
// ── Prompt serialization lock ───────────────────────────────────────────
// Prevents concurrent askUser() calls from interleaving their prompts.
let promptQueue = Promise.resolve();
// ── ANSI colors ─────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const READ_TOOLS = new Set(["read_file", "glob", "grep", "git_status", "git_diff", "phren_search", "phren_get_tasks"]);
const DANGEROUS_TOOLS = new Set(["shell"]);
function classifyRisk(toolName) {
    if (READ_TOOLS.has(toolName))
        return "read";
    if (DANGEROUS_TOOLS.has(toolName))
        return "dangerous";
    return "write";
}
function riskColor(risk) {
    switch (risk) {
        case "read": return GREEN;
        case "write": return YELLOW;
        case "dangerous": return RED;
    }
}
function riskLabel(risk) {
    switch (risk) {
        case "read": return "READ";
        case "write": return "WRITE";
        case "dangerous": return "SHELL";
    }
}
// ── Summary generation ──────────────────────────────────────────────────
function summarizeCall(toolName, input) {
    switch (toolName) {
        case "read_file": {
            const p = input.path || "?";
            const offset = input.offset ? ` from line ${input.offset}` : "";
            const limit = input.limit ? ` (${input.limit} lines)` : "";
            return `Read ${p}${offset}${limit}`;
        }
        case "write_file": {
            const p = input.path || "?";
            const content = input.content || "";
            const lines = content.split("\n").length;
            return `Write ${lines} lines to ${p}`;
        }
        case "edit_file": {
            const p = input.path || "?";
            return `Edit ${p}`;
        }
        case "glob": {
            const pattern = input.pattern || "?";
            const dir = input.path || ".";
            return `Glob "${pattern}" in ${dir}`;
        }
        case "grep": {
            const pattern = input.pattern || "?";
            const dir = input.path || ".";
            return `Grep "${pattern}" in ${dir}`;
        }
        case "shell": {
            const cmd = input.command || "?";
            return cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
        }
        case "git_commit": {
            const msg = input.message || "";
            return `Commit: ${msg.slice(0, 80)}`;
        }
        case "phren_add_finding":
            return `Save finding to phren`;
        case "phren_complete_task":
            return `Complete phren task`;
        default: {
            const keys = Object.keys(input);
            return keys.length > 0 ? `${toolName}(${keys.join(", ")})` : toolName;
        }
    }
}
/**
 * Ask the user on stderr whether to allow a tool call.
 * Returns true if user approves (y, a, or s), false if denied (n).
 *
 * Side effect: "a" and "s" responses add to the session allowlist.
 */
export async function askUser(toolName, input, reason) {
    // Serialize: wait for any prior prompt to finish before showing ours
    let resolve;
    const gate = new Promise((r) => { resolve = r; });
    const previous = promptQueue;
    promptQueue = gate;
    await previous;
    try {
        const risk = classifyRisk(toolName);
        const color = riskColor(risk);
        const label = riskLabel(risk);
        const summary = summarizeCall(toolName, input);
        // Header
        process.stderr.write(`\n${color}${BOLD}[${label}]${RESET} ${BOLD}${toolName}${RESET}\n`);
        process.stderr.write(`${DIM}  ${reason}${RESET}\n`);
        process.stderr.write(`${CYAN}  ${summary}${RESET}\n`);
        // Show full input for shell commands or when details matter
        if (toolName === "shell") {
            const cmd = input.command || "";
            if (cmd.length > 120) {
                process.stderr.write(`${DIM}  Full command:${RESET}\n`);
                process.stderr.write(`${DIM}  ${cmd}${RESET}\n`);
            }
        }
        const result = await promptKey();
        // Persist allowlist entries for session/tool scopes
        if (result === "allow-session") {
            addAllow(toolName, input, "session");
        }
        else if (result === "allow-tool") {
            addAllow(toolName, input, "tool");
        }
        return result !== "deny";
    }
    finally {
        resolve();
    }
}
/**
 * Read a single keypress from stdin.
 * Temporarily exits raw mode if the TUI has it enabled, restores after.
 */
async function promptKey() {
    const hint = `${DIM}  [y]es  [n]o  [a]llow-tool  [s]ession-allow${RESET}  `;
    process.stderr.write(hint);
    const wasRaw = process.stdin.isTTY && process.stdin.isRaw;
    return new Promise((resolve) => {
        if (process.stdin.isTTY) {
            // Single-keypress mode
            if (!wasRaw) {
                process.stdin.setRawMode(true);
            }
            process.stdin.resume();
            const onData = (data) => {
                process.stdin.removeListener("data", onData);
                if (!wasRaw && process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
                process.stdin.pause();
                const key = data.toString().trim().toLowerCase();
                process.stderr.write(key + "\n");
                switch (key) {
                    case "y":
                        resolve("allow");
                        break;
                    case "a":
                        resolve("allow-tool");
                        break;
                    case "s":
                        resolve("allow-session");
                        break;
                    case "n":
                        resolve("deny");
                        break;
                    case "\x03": // Ctrl+C
                        process.stderr.write("\n");
                        resolve("deny");
                        break;
                    default:
                        resolve("deny"); // Unknown key = deny (safe default)
                }
            };
            process.stdin.on("data", onData);
        }
        else {
            // Non-TTY fallback: readline
            const iface = readline.createInterface({ input: process.stdin, output: process.stderr });
            iface.question("", (answer) => {
                iface.close();
                const key = answer.trim().toLowerCase();
                switch (key) {
                    case "y":
                        resolve("allow");
                        break;
                    case "a":
                        resolve("allow-tool");
                        break;
                    case "s":
                        resolve("allow-session");
                        break;
                    default: resolve("deny");
                }
            });
        }
    });
}
