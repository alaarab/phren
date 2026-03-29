/**
 * Interactive session resume picker.
 *
 * Lists recent sessions and lets the user pick one by number or name.
 * Uses readline (not raw mode) for broad terminal compatibility.
 */

import * as readline from "node:readline/promises";
import { listRecentSessions, type SessionInfo } from "./memory/session.js";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Format a relative time string like "2h ago" or "3d ago". */
function relativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return "unknown";

  const diffMs = now - then;
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

/** Format a session line for display. */
function formatSessionLine(index: number, session: SessionInfo): string {
  const timeStr = relativeTime(session.timestamp);
  const nameOrSummary = session.name
    ? `"${session.name}"`
    : session.summary;
  const turnSuffix = session.turnCount ? ` ${DIM}(${session.turnCount} turns)${RESET}` : "";
  return `  ${CYAN}[${index + 1}]${RESET} ${DIM}${timeStr}${RESET} -- ${nameOrSummary}${turnSuffix}`;
}

/**
 * Interactive session picker.
 *
 * Displays recent sessions and prompts the user to select one by number or
 * type a session name. Returns the session ID of the selected session, or
 * null if the user cancels (empty input, "q", Ctrl-C).
 */
export async function pickSession(phrenPath: string): Promise<string | null> {
  const sessions = listRecentSessions(phrenPath, 10);

  if (sessions.length === 0) {
    process.stderr.write(`${YELLOW}No recent sessions found.${RESET}\n`);
    return null;
  }

  process.stderr.write(`\n${CYAN}Recent sessions:${RESET}\n\n`);
  for (let i = 0; i < sessions.length; i++) {
    process.stderr.write(formatSessionLine(i, sessions[i]) + "\n");
  }
  process.stderr.write(`\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  try {
    const answer = await rl.question(`${DIM}Pick a session number (1-${sessions.length}), name, or Enter to cancel:${RESET} `);
    const trimmed = answer.trim();

    // Cancel on empty input or "q"
    if (!trimmed || trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "cancel") {
      return null;
    }

    // Try as a number first
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= sessions.length) {
      return sessions[num - 1].id;
    }

    // Try as a session name (case-insensitive substring match)
    const match = sessions.find(s =>
      s.name?.toLowerCase().includes(trimmed.toLowerCase()) ||
      s.id.startsWith(trimmed),
    );
    if (match) {
      return match.id;
    }

    process.stderr.write(`${YELLOW}No matching session found.${RESET}\n`);
    return null;
  } catch {
    // Ctrl-C or stream closed
    return null;
  } finally {
    rl.close();
  }
}
