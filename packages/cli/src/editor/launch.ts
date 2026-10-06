/**
 * Hand a file to the user's own editor.
 *
 * `$EDITOR` is a command line, not a binary path. Plenty of people set it to
 * something carrying arguments — `code --wait`, `nvim -u NONE`, and on this
 * machine `omarchy-launch-editor --inline` — so passing it straight to
 * `execFileSync` looks for a binary with spaces in its name and fails with
 * ENOENT. Git treats `core.editor` as a command line for the same reason, and
 * so do we: split it, append the path, run the first word.
 *
 * Splitting rather than `shell: true` keeps a file path from ever being
 * interpreted by a shell.
 */

import { execFileSync } from "child_process";
import { resolveExecCommand } from "../utils-helpers.js";
import { errorMessage } from "../utils.js";
import { debugLog } from "../shared.js";

export interface EditorCommand {
  command: string;
  args: string[];
}

/**
 * Split a command line into a command and its arguments, honouring single and
 * double quotes so a quoted path with spaces survives. Backslash escapes are
 * deliberately not handled: `$EDITOR` values that need them are vanishingly
 * rare, and guessing wrong is worse than not trying.
 */
export function splitCommandLine(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has || current) { parts.push(current); current = ""; has = false; }
      continue;
    }
    current += ch;
  }
  if (has || current) parts.push(current);
  return parts;
}

/** The editor to use, from `$EDITOR`, then `$VISUAL`, then a sensible default. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): EditorCommand | null {
  const raw = (env.EDITOR || env.VISUAL || "").trim();
  const parts = raw ? splitCommandLine(raw) : [];
  if (!parts.length) {
    // Nothing configured. `vi` is the one editor POSIX requires to exist.
    return { command: "vi", args: [] };
  }
  const [command, ...args] = parts;
  return command ? { command, args } : null;
}

export interface EditorResult {
  ok: boolean;
  /** The command that ran, for messages. */
  command: string;
  error?: string;
}

/**
 * Run the editor on `filePath` and wait for it to exit. The child inherits the
 * terminal, so the caller must have released it first.
 *
 * Returns a result rather than throwing or exiting: inside the shell an editor
 * that will not start is a message on the status line, not the end of the
 * session.
 */
export function openInEditor(filePath: string, env: NodeJS.ProcessEnv = process.env): EditorResult {
  const editor = resolveEditorCommand(env);
  if (!editor) return { ok: false, command: "", error: "No editor configured. Set $EDITOR." };
  const resolved = resolveExecCommand(editor.command);
  try {
    execFileSync(resolved.command, [...editor.args, filePath], {
      stdio: "inherit",
      shell: resolved.shell,
    });
    return { ok: true, command: editor.command };
  } catch (err: unknown) {
    const error = errorMessage(err);
    debugLog(`openInEditor: ${editor.command}: ${error}`);
    return { ok: false, command: editor.command, error };
  }
}
