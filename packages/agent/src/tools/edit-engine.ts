/**
 * Pure string-edit engine shared by edit_file, multi_edit and apply_patch.
 *
 * Matching order for one edit:
 *   1. exact substring (the only mode that honours replace_all);
 *   2. the same after stripping read_file's `N\t` line-number prefixes, a
 *      common copy mistake;
 *   3. whole-line match ignoring trailing whitespace, then ignoring
 *      indentation (re-indenting new_string to the file's indentation).
 *
 * A CRLF file is edited in LF form and converted back, so a model that sends
 * `\n` still matches. Every failure message says what to do next: the
 * locations of an ambiguous match, or the closest region of the file and the
 * first line that differs.
 */

export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export type EditOutcome =
  | { ok: true; content: string; replacements: number; firstLine: number; lastLine: number; note?: string }
  | { ok: false; error: string };

const LINE_PREFIX_RE = /^\s*\d+\t/;

/** 1-based line number of a character offset. */
export function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function occurrences(content: string, needle: string): number[] {
  const out: number[] = [];
  let at = content.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = content.indexOf(needle, at + needle.length);
  }
  return out;
}

function stripLinePrefixes(text: string): string | null {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => LINE_PREFIX_RE.test(l))) return null;
  return lines.map((l) => l.replace(LINE_PREFIX_RE, "")).join("\n");
}

function leadingWs(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** Bigram Dice similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hits++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

/**
 * The file region most similar to `needleLines`, for failure messages.
 * Bounded so a large file cannot make a failed edit slow.
 */
export function closestRegion(
  fileLines: string[],
  needleLines: string[],
): { start: number; score: number } | null {
  const n = Math.min(needleLines.length, 60);
  if (n === 0 || fileLines.length === 0) return null;
  const needle = needleLines.slice(0, n).map((l) => l.trim());
  const firstReal = needle.findIndex((l) => l.length > 0);
  if (firstReal === -1) return null;
  const last = Math.max(0, fileLines.length - n);
  const exhaustive = (last + 1) * n <= 400_000;
  let best: { start: number; score: number } | null = null;
  for (let start = 0; start <= last; start++) {
    // On big files only score windows whose anchor line is already close.
    if (!exhaustive && similarity(fileLines[start + firstReal]?.trim() ?? "", needle[firstReal]) < 0.5) continue;
    let total = 0;
    let counted = 0;
    for (let j = 0; j < n; j++) {
      const want = needle[j];
      const got = fileLines[start + j]?.trim() ?? "";
      if (!want && !got) continue;
      total += similarity(got, want);
      counted++;
    }
    const score = counted > 0 ? total / counted : 0;
    if (!best || score > best.score) best = { start, score };
  }
  return best;
}

/** A read_file-style excerpt, for failure messages. */
function excerpt(fileLines: string[], start: number, count: number): string {
  return fileLines
    .slice(start, start + count)
    .map((l, i) => `${start + i + 1}\t${l.length > 200 ? `${l.slice(0, 200)}…` : l}`)
    .join("\n");
}

export function describeNotFound(content: string, oldString: string, what = "old_string"): string {
  const fileLines = content.split("\n");
  const needleLines = oldString.replace(/\n$/, "").split("\n");
  const parts = [`${what} was not found in the file.`];
  const region = closestRegion(fileLines, needleLines);
  if (region && region.score >= 0.5) {
    const count = Math.min(needleLines.length, 60);
    parts.push(
      `Closest match: lines ${region.start + 1}-${region.start + count} (${Math.round(region.score * 100)}% similar):`,
      excerpt(fileLines, region.start, count),
    );
    for (let j = 0; j < count; j++) {
      const got = fileLines[region.start + j] ?? "";
      if (got !== needleLines[j]) {
        parts.push(
          `First difference at line ${region.start + j + 1}:\n  expected: ${JSON.stringify(needleLines[j])}\n  file has: ${JSON.stringify(got)}`,
        );
        break;
      }
    }
  }
  parts.push("Re-read the file with read_file and copy the text exactly (without the line-number prefix).");
  return parts.join("\n");
}

function describeAmbiguous(content: string, offsets: number[], what = "old_string"): string {
  const lines = offsets.slice(0, 10).map((o) => lineOfOffset(content, o));
  const more = offsets.length > 10 ? `, … ${offsets.length - 10} more` : "";
  return `${what} matches ${offsets.length} locations (lines ${lines.join(", ")}${more}). ` +
    "Include more surrounding lines to make it unique, or set replace_all: true to change every occurrence.";
}

type LineNormalizer = (line: string) => string;
const LINE_LEVELS: Array<{ norm: LineNormalizer; label: string; reindent: boolean }> = [
  { norm: (l) => l.trimEnd(), label: "ignoring trailing whitespace", reindent: false },
  { norm: (l) => l.trim(), label: "ignoring indentation", reindent: true },
];

/** Line-window match under normalization; returns every start index. */
function lineMatches(fileLines: string[], needle: string[], norm: LineNormalizer): number[] {
  const want = needle.map(norm);
  const out: number[] = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (norm(fileLines[i + j]) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function reindent(newLines: string[], fromIndent: string, toIndent: string): string[] {
  if (fromIndent === toIndent) return newLines;
  return newLines.map((l) => {
    if (l.trim() === "") return l;
    if (l.startsWith(fromIndent)) return toIndent + l.slice(fromIndent.length);
    return l;
  });
}

function applyLF(content: string, spec: EditSpec): EditOutcome {
  const { old_string: oldStr, new_string: newStr, replace_all: all } = spec;

  // 1. Exact.
  const hits = occurrences(content, oldStr);
  if (hits.length === 1 || (hits.length > 1 && all)) {
    const out = all ? content.split(oldStr).join(newStr) : content.slice(0, hits[0]) + newStr + content.slice(hits[0] + oldStr.length);
    const firstLine = lineOfOffset(content, hits[0]);
    const lastHit = hits[hits.length - 1];
    return {
      ok: true,
      content: out,
      replacements: all ? hits.length : 1,
      firstLine,
      lastLine: lineOfOffset(content, lastHit) + newStr.split("\n").length - 1,
    };
  }
  if (hits.length > 1) return { ok: false, error: describeAmbiguous(content, hits) };

  // 2. read_file line-number prefixes pasted into old_string.
  const strippedOld = stripLinePrefixes(oldStr);
  if (strippedOld !== null && strippedOld !== oldStr) {
    const strippedNew = stripLinePrefixes(newStr) ?? newStr;
    const retry = applyLF(content, { old_string: strippedOld, new_string: strippedNew, replace_all: all });
    if (retry.ok) return { ...retry, note: "removed read_file line-number prefixes from old_string" };
  }

  // 3. Whole-line fuzzy matches (single replacement only).
  if (!all) {
    const trailingNl = oldStr.endsWith("\n");
    const needle = (trailingNl ? oldStr.slice(0, -1) : oldStr).split("\n");
    if (needle.some((l) => l.trim().length > 0)) {
      const fileLines = content.split("\n");
      for (const level of LINE_LEVELS) {
        const starts = lineMatches(fileLines, needle, level.norm);
        if (starts.length > 1) {
          const offsets = starts.map((s) => fileLines.slice(0, s).join("\n").length + (s > 0 ? 1 : 0));
          return { ok: false, error: `${describeAmbiguous(content, offsets)} (matched ${level.label})` };
        }
        if (starts.length === 1) {
          const start = starts[0];
          let newLines = (trailingNl && newStr.endsWith("\n") ? newStr.slice(0, -1) : newStr).split("\n");
          if (level.reindent) {
            const firstIdx = needle.findIndex((l) => l.trim().length > 0);
            newLines = reindent(newLines, leadingWs(needle[firstIdx]), leadingWs(fileLines[start + firstIdx]));
          }
          const replaced = newStr === "" && !trailingNl ? [] : newLines;
          const out = [...fileLines.slice(0, start), ...replaced, ...fileLines.slice(start + needle.length)];
          return {
            ok: true,
            content: out.join("\n"),
            replacements: 1,
            firstLine: start + 1,
            lastLine: start + Math.max(1, replaced.length),
            note: `matched ${level.label}`,
          };
        }
      }
    }
  }

  return { ok: false, error: describeNotFound(content, oldStr) };
}

/** Apply one edit to file content. Never throws. */
export function applyEdit(content: string, spec: EditSpec): EditOutcome {
  if (typeof spec.old_string !== "string" || typeof spec.new_string !== "string") {
    return { ok: false, error: "old_string and new_string must both be strings." };
  }
  if (spec.old_string === "") {
    return { ok: false, error: "old_string must not be empty. Use write_file to create a file, or include existing text to anchor the edit." };
  }
  if (spec.old_string === spec.new_string) {
    return { ok: false, error: "old_string and new_string are identical; nothing would change." };
  }
  // Edit CRLF files in LF form (models almost always send \n), then restore.
  const crlf = content.includes("\r\n") && !/(^|[^\r])\n/.test(content);
  if (!crlf) return applyLF(content, spec);
  const toLF = (s: string) => s.replace(/\r\n/g, "\n");
  const result = applyLF(toLF(content), {
    old_string: toLF(spec.old_string),
    new_string: toLF(spec.new_string),
    replace_all: spec.replace_all,
  });
  if (!result.ok) return result;
  return { ...result, content: result.content.replace(/\n/g, "\r\n") };
}

/** Apply edits in order, all or nothing. */
export function applyEdits(content: string, edits: EditSpec[]): EditOutcome {
  let current = content;
  let replacements = 0;
  let firstLine = Number.POSITIVE_INFINITY;
  let lastLine = 0;
  const notes: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const r = applyEdit(current, edits[i]);
    if (!r.ok) {
      return { ok: false, error: `Edit ${i + 1} of ${edits.length} failed: ${r.error}\nNo changes were written; earlier edits in this call were not applied either.` };
    }
    current = r.content;
    replacements += r.replacements;
    firstLine = Math.min(firstLine, r.firstLine);
    lastLine = Math.max(lastLine, r.lastLine);
    if (r.note) notes.push(`edit ${i + 1}: ${r.note}`);
  }
  return {
    ok: true,
    content: current,
    replacements,
    firstLine: Number.isFinite(firstLine) ? firstLine : 1,
    lastLine,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

/** A few numbered lines around an edited range so the model sees the result without re-reading. */
export function snippetAround(content: string, firstLine: number, lastLine: number, context = 3, maxLines = 40): string {
  const lines = content.split("\n");
  const from = Math.max(1, firstLine - context);
  const to = Math.min(lines.length, Math.max(lastLine, firstLine) + context);
  const shown = lines.slice(from - 1, Math.min(to, from - 1 + maxLines));
  const body = shown.map((l, i) => `${from + i}\t${l.length > 300 ? `${l.slice(0, 300)}…` : l}`).join("\n");
  return to - from + 1 > maxLines ? `${body}\n… (${to - from + 1 - maxLines} more lines)` : body;
}
