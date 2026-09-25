import * as fs from "fs";
import * as path from "path";
import { AGENT_INSTRUCTIONS_FILENAME, LEGACY_AGENT_INSTRUCTIONS_FILENAME } from "../agent-instructions.js";
import { atomicWriteText, debugLog, getProjectDirs } from "../shared.js";
import { errorMessage } from "../utils.js";

// Claude Code expands `@path` lines in CLAUDE.md as file imports, resolved
// against the real location of the file. A repo's CLAUDE.md is a symlink into
// the store, so every such import lands in ~/.phren/<project>/... — outside
// the repo — and Claude Code (2.1.278+) blocks on an "Allow external CLAUDE.md
// file imports?" dialog per project, or silently drops the import headless.
// The archive is retrieved by the hook on demand anyway, so the fix is a plain
// mention instead of an import.

const IMPORT_LINE_RE = /^@(?![a-z0-9-]+\/[a-z0-9-]+$)(\S+)\s*$/i;

export interface ContextImportHit {
  scope: string;
  file: string;
  line: number;
  target: string;
}

export function findContextImportLines(content: string): Array<{ line: number; target: string }> {
  const hits: Array<{ line: number; target: string }> = [];
  let inFence = false;
  content.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = IMPORT_LINE_RE.exec(line);
    if (m) hits.push({ line: i + 1, target: m[1] });
  });
  return hits;
}

/** Turn each run of `@path` lines into one plain reference list. */
export function rewriteContextImports(content: string): string {
  const lines = content.split("\n");
  const flagged = new Set(findContextImportLines(content).map((h) => h.line - 1));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!flagged.has(i)) { out.push(lines[i]); continue; }
    const run: string[] = [];
    while (i < lines.length && (flagged.has(i) || (run.length && lines[i].trim() === "" && flagged.has(i + 1)))) {
      if (flagged.has(i)) run.push(lines[i].trim().slice(1));
      i++;
    }
    i--;
    out.push("Reference docs (the phren hook injects relevant parts on demand; not imported):");
    for (const target of run) out.push(`- \`${target}\``);
  }
  return out.join("\n");
}

function contextFilesIn(dir: string): string[] {
  return [AGENT_INSTRUCTIONS_FILENAME, LEGACY_AGENT_INSTRUCTIONS_FILENAME]
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try { return fs.lstatSync(file).isFile(); } catch { return false; }
    });
}

export function scanContextImports(phrenPath: string): ContextImportHit[] {
  const hits: ContextImportHit[] = [];
  const scopeDirs = [path.join(phrenPath, "global"), ...getProjectDirs(phrenPath)];
  for (const dir of scopeDirs) {
    for (const file of contextFilesIn(dir)) {
      let content: string;
      try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const hit of findContextImportLines(content)) hits.push({ scope: path.basename(dir), file, ...hit });
    }
  }
  return hits;
}

/** Rewrite every flagged file in place; returns the files changed. */
export function fixContextImports(phrenPath: string, hits: ContextImportHit[]): string[] {
  const fixed: string[] = [];
  for (const file of [...new Set(hits.map((h) => h.file))]) {
    try {
      const content = fs.readFileSync(file, "utf8");
      const next = rewriteContextImports(content);
      if (next !== content) { atomicWriteText(file, next); fixed.push(file); }
    } catch (err: unknown) {
      debugLog(`context-imports: could not rewrite ${file}: ${errorMessage(err)}`);
    }
  }
  return fixed;
}
