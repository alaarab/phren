/**
 * Tool call rendering: duration formatting, input preview, compact output.
 */
import { s, cols } from "./ansi.js";

export const COMPACT_LINES = 3;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file": return input.file_path as string ?? "";
    case "shell": return (input.command as string ?? "").slice(0, 60);
    case "glob": return input.pattern as string ?? "";
    case "grep": return `/${input.pattern ?? ""}/ ${input.path ?? ""}`;
    case "git_commit": return (input.message as string ?? "").slice(0, 50);
    case "phren_search": return input.query as string ?? "";
    case "phren_add_finding": return (input.finding as string ?? "").slice(0, 50);
    default: return JSON.stringify(input).slice(0, 60);
  }
}

export function renderToolCall(name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number): string {
  const preview = formatToolInput(name, input);
  const dur = formatDuration(durationMs);
  const icon = isError ? s.red("✗") : s.green("→");
  const header = `  ${icon} ${s.bold(name)} ${s.gray(preview)}  ${s.dim(dur)}`;

  // Compact: show first 3 lines only, with overflow count
  const allLines = output.split("\n").filter(Boolean);
  if (allLines.length === 0) return header;
  const shown = allLines.slice(0, COMPACT_LINES);
  const body = shown.map((l) => s.dim(`    ${l.slice(0, cols() - 6)}`)).join("\n");
  const overflow = allLines.length - COMPACT_LINES;
  const more = overflow > 0 ? `\n${s.dim(`    ... +${overflow} lines`)}` : "";

  return `${header}\n${body}${more}`;
}
