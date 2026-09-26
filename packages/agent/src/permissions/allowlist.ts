/**
 * Session-scoped allowlist for tool permissions.
 *
 * Tracks tool+pattern combos that the user has approved via "allow-session" (s)
 * in the permission prompt. Checked before mode-based rules so approved tools
 * skip the interactive prompt for the rest of the session.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** An entry in the session allowlist. */
interface AllowEntry {
  toolName: string;
  /** Pattern to match: file path for file tools, command prefix for shell. "*" = any input. */
  pattern: string;
  scope?: "project" | "global";
}

export type AllowScope = "once" | "session" | "tool" | "project" | "global";

export const PERSISTED_ALLOWLIST_FILE = path.join(os.homedir(), ".phren-agent", "permissions.json");

interface PersistedAllowlist {
  version: number;
  global: AllowEntry[];
  projects: Record<string, AllowEntry[]>;
}

const sessionAllowlist: AllowEntry[] = [];
const persistentAllowlist: AllowEntry[] = [];
let persistentProjectRoot: string | null = null;

/**
 * Extract a matchable pattern from tool input.
 * - File tools: the path argument
 * - Shell: first token of the command (the binary)
 * - Other tools: "*" (wildcard — allow all invocations)
 */
export function extractPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "shell") {
    const cmd = ((input.command as string) || "").trim();
    // Use the first token (the binary) as the pattern
    return cmd.split(/\s+/)[0] || "*";
  }

  const filePath = (input.path as string) || (input.file_path as string) || "";
  if (filePath) return filePath;

  return "*";
}

function matches(entry: AllowEntry, toolName: string, pattern: string): boolean {
  if (entry.toolName !== toolName) return false;
  if (entry.pattern === "*") return true;
  // For file paths: exact match or child path (boundary-aware to prevent prefix collisions)
  if (pattern === entry.pattern || pattern.startsWith(entry.pattern.endsWith("/") ? entry.pattern : entry.pattern + "/")) return true;
  // For shell commands: match the binary name
  return entry.pattern === pattern;
}

/** Check if a tool call is in the session allowlist. */
export function isAllowed(toolName: string, input: Record<string, unknown>): boolean {
  if (sessionAllowlist.length === 0 && persistentAllowlist.length === 0) return false;
  const pattern = extractPattern(toolName, input);

  return (
    sessionAllowlist.some((entry) => matches(entry, toolName, pattern)) ||
    persistentAllowlist.some((entry) => matches(entry, toolName, pattern))
  );
}

function readPersisted(): PersistedAllowlist {
  try {
    const raw = JSON.parse(fs.readFileSync(PERSISTED_ALLOWLIST_FILE, "utf-8"));
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    return {
      version: 1,
      global: Array.isArray(raw.global) ? raw.global.filter(isEntry) : [],
      projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
    };
  } catch {
    return { version: 1, global: [], projects: {} };
  }
}

function isEntry(value: unknown): value is AllowEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as { toolName?: unknown; pattern?: unknown };
  return typeof entry.toolName === "string" && typeof entry.pattern === "string";
}

function writePersisted(data: PersistedAllowlist): void {
  try {
    fs.mkdirSync(path.dirname(PERSISTED_ALLOWLIST_FILE), { recursive: true });
    fs.writeFileSync(PERSISTED_ALLOWLIST_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch { /* best effort */ }
}

export function loadPersistentAllowlist(projectRoot?: string): void {
  const data = readPersisted();
  persistentProjectRoot = projectRoot ?? null;
  persistentAllowlist.length = 0;
  for (const entry of data.global) {
    persistentAllowlist.push({ ...entry, scope: "global" });
  }
  if (projectRoot) {
    const projectEntries = data.projects[projectRoot];
    if (Array.isArray(projectEntries)) {
      for (const entry of projectEntries) {
        persistentAllowlist.push({ ...entry, scope: "project" });
      }
    }
  }
}

function persistEntry(entry: AllowEntry, scope: "project" | "global", projectRoot?: string): void {
  const data = readPersisted();
  const list = scope === "global"
    ? data.global
    : (data.projects[projectRoot ?? process.cwd()] ??= []);

  if (!list.some((e) => e.toolName === entry.toolName && e.pattern === entry.pattern)) {
    list.push({ toolName: entry.toolName, pattern: entry.pattern });
  }
  writePersisted(data);
}

/** Add a tool+pattern to the session allowlist. */
export function addAllow(
  toolName: string,
  input: Record<string, unknown>,
  scope: AllowScope,
  projectRoot?: string,
): void {
  if (scope === "once") return; // "once" approvals don't persist

  // For shell commands, never allow "*" — always scope to the binary name
  const pattern = scope === "tool" && toolName !== "shell"
    ? "*"
    : extractPattern(toolName, input);

  if (scope === "project" || scope === "global") {
    const entry: AllowEntry = { toolName, pattern, scope };
    persistEntry(entry, scope, projectRoot);
    const root = projectRoot ?? process.cwd();
    if (scope === "project" && persistentProjectRoot !== root) return;
    if (!persistentAllowlist.some((e) => e.toolName === toolName && e.pattern === pattern && e.scope === scope)) {
      persistentAllowlist.push(entry);
    }
    return;
  }

  // Avoid duplicates
  const exists = sessionAllowlist.some(
    (e) => e.toolName === toolName && e.pattern === pattern,
  );
  if (!exists) {
    sessionAllowlist.push({ toolName, pattern });
  }
}

/** Clear the session allowlist (e.g., on session reset). */
export function clearAllowlist(): void {
  sessionAllowlist.length = 0;
}
