/**
 * Find one finding wherever it lives and rewrite its line in place.
 *
 * A project keeps its newest findings in FINDINGS.md; older ones move to topic
 * archives (reference/topics/<slug>.md), and an oversized topic spills its
 * oldest sections into <slug>.older.md. All three use the FINDINGS.md bullet
 * format (docs/store-format.md §4.6), so a finding is addressed by file and
 * line, and a write splices that one line under the file's lock. Nothing else
 * in the file is re-serialised: line endings, blank lines and the trailing
 * newline stay byte for byte as they were.
 */
import * as fs from "fs";
import * as path from "path";
import { FINDINGS_FILENAME } from "../filenames.js";
import { atomicWriteText } from "../phren-paths.js";
import { PhrenError, phrenErr, phrenOk, type PhrenResult } from "../phren-core.js";
import { withSafeLock } from "../shared/data-utils.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { parseCitationComment, type FindingCitation } from "../content/citation.js";
import {
  isArchiveEnd,
  isArchiveStart,
  isCitationLine,
  normalizeFindingText,
  parseFindingId,
  stripComments,
  withoutTypeTag,
} from "../content/metadata.js";
import { parseFindingLifecycle, type FindingLifecycleStatus } from "./lifecycle.js";

export type FindingTier = "active" | "topic" | "older";

export interface ProjectFinding {
  file: string;
  tier: FindingTier;
  /** 0-based line of the bullet in its file. */
  lineIndex: number;
  /** The bullet as stored, without its line ending. */
  line: string;
  fid?: string;
  /** What readFindings shows: no bullet marker, comments or confidence marker. */
  text: string;
  status: FindingLifecycleStatus;
  /** Inside a legacy <details> / phren:archive block, which nothing writes (store-format §5.2). */
  archived: boolean;
  /** The phren:cite comment on the line under the bullet. */
  citation?: FindingCitation;
}

/** What a writer needs to find a located finding again. */
export type FindingHandle = Pick<ProjectFinding, "file" | "lineIndex" | "line">;

/** A string selector is a fid when written `fid:xxxxxxxx`, finding text otherwise. */
export type FindingSelector = { fid: string } | { text: string };

export type LocateResult =
  | { kind: "found"; finding: ProjectFinding }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: ProjectFinding[] };

export interface RewrittenFinding {
  file: string;
  lineIndex: number;
  before: string;
  /** The new line, or null when the finding was removed. */
  after: string | null;
}

interface Bullet {
  lineIndex: number;
  line: string;
  archived: boolean;
  citation?: string;
}

/** FINDINGS.md, then every topic archive and older half in name order. */
function findingFiles(dir: string, checkedPath?: (file: string, directory?: boolean) => string | undefined): Array<{ file: string; tier: FindingTier }> {
  const files: Array<{ file: string; tier: FindingTier }> = [];
  const active = path.join(dir, FINDINGS_FILENAME);
  if (checkedPath || fs.existsSync(active)) files.push({ file: active, tier: "active" });
  const topicsDir = path.join(dir, "reference", "topics");
  const topicsPath = checkedPath ? checkedPath(topicsDir, true) : topicsDir;
  if (!topicsPath) return files;
  let names: string[] = [];
  try { names = fs.readdirSync(topicsPath); } catch { /* nothing archived yet */ }
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    files.push({ file: path.join(topicsDir, name), tier: name.endsWith(".older.md") ? "older" : "topic" });
  }
  return files;
}

function isFindingFile(phrenPath: string, project: string, file: string): boolean {
  const dir = storeAwareProjectPath(phrenPath, project);
  if (!dir) return false;
  const resolved = path.resolve(file);
  if (resolved === path.resolve(dir, FINDINGS_FILENAME)) return true;
  return resolved.endsWith(".md") && path.dirname(resolved) === path.resolve(dir, "reference", "topics");
}

/** Every "- " bullet the way readFindings walks a file: archive blocks tracked, a bullet's phren:cite line consumed with it. */
function scanBullets(lines: string[]): Bullet[] {
  const out: Bullet[] = [];
  let archived = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (isArchiveStart(line)) { archived = true; continue; }
    if (isArchiveEnd(line)) { archived = false; continue; }
    if (!line.startsWith("- ")) continue;
    const next = lines[i + 1] ?? "";
    const citation = isCitationLine(next) ? next.trim() : undefined;
    out.push({ lineIndex: i, line, archived, ...(citation ? { citation } : {}) });
    if (citation) i++;
  }
  return out;
}

function displayText(line: string): string {
  return stripComments(line.replace(/^-\s+/, "").trim()).replace(/\s*\[confidence\s+[01](?:\.\d+)?\]\s*$/i, "").trim();
}

function toFinding(file: string, tier: FindingTier, bullet: Bullet): ProjectFinding {
  const fid = parseFindingId(bullet.line);
  const citation = bullet.citation ? parseCitationComment(bullet.citation) ?? undefined : undefined;
  return {
    file,
    tier,
    lineIndex: bullet.lineIndex,
    line: bullet.line,
    ...(fid ? { fid } : {}),
    text: displayText(bullet.line),
    status: parseFindingLifecycle(bullet.line).status,
    archived: bullet.archived,
    ...(citation ? { citation } : {}),
  };
}

/** Every finding bullet of a project: FINDINGS.md, each topic archive and each .older.md half. */
export function* iterateProjectFindings(phrenPath: string, project: string, scope?: {
  projectDir: string;
  onSkipped: (file: string, reason: string) => void;
}): Generator<ProjectFinding> {
  const dir = scope?.projectDir ?? storeAwareProjectPath(phrenPath, project);
  if (!dir) return;
  const root = scope && fs.realpathSync.native(dir);
  const checkedPath = scope && root ? (file: string, directory = false): string | undefined => {
    let reason: string;
    try {
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
      const resolved = fs.realpathSync.native(file);
      const relative = path.relative(root, resolved);
      if (path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") reason = "outside the selected project";
      else {
        const stat = fs.statSync(resolved);
        if (directory ? stat.isDirectory() : stat.isFile()) return resolved;
        reason = directory ? "expected a directory" : "expected a regular file";
      }
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    scope.onSkipped(file, reason);
    return undefined;
  } : undefined;
  for (const { file, tier } of findingFiles(dir, checkedPath)) {
    const source = checkedPath ? checkedPath(file) : file;
    if (!source) continue;
    let content: string;
    try { content = fs.readFileSync(source, "utf8"); } catch { continue; }
    for (const bullet of scanBullets(content.split("\n"))) yield toFinding(file, tier, bullet);
  }
}

/**
 * Exactly one finding by fid or by text, or why not. Text matches after
 * normalizeFindingText, falling back to ignoring a type tag one side lacks;
 * it never matches part of a finding.
 */
export function locateFinding(phrenPath: string, project: string, selector: FindingSelector | string): LocateResult {
  const wanted = typeof selector !== "string" ? selector
    : /^fid:/i.test(selector.trim()) ? { fid: selector.trim().slice(4) } : { text: selector };
  const all = [...iterateProjectFindings(phrenPath, project)];
  let matches: ProjectFinding[];
  if ("fid" in wanted) {
    const fid = wanted.fid.trim().toLowerCase();
    matches = fid ? all.filter((f) => f.fid?.toLowerCase() === fid) : [];
  } else {
    const needle = normalizeFindingText(wanted.text);
    if (!needle) return { kind: "not_found" };
    matches = all.filter((f) => normalizeFindingText(f.line) === needle);
    if (matches.length === 0) matches = all.filter((f) => withoutTypeTag(normalizeFindingText(f.line)) === withoutTypeTag(needle));
  }
  if (matches.length === 1) return { kind: "found", finding: matches[0] };
  return matches.length === 0 ? { kind: "not_found" } : { kind: "ambiguous", candidates: matches };
}

/** The handle's bullet in the file as it is now: in place, or moved to exactly one line with its fid (else its exact text). */
function refind(bullets: Bullet[], handle: FindingHandle): PhrenResult<Bullet> {
  const where = path.basename(handle.file);
  const inPlace = bullets.find((b) => b.lineIndex === handle.lineIndex);
  if (inPlace?.line === handle.line) return phrenOk(inPlace);
  const fid = parseFindingId(handle.line)?.toLowerCase();
  const same = fid
    ? bullets.filter((b) => parseFindingId(b.line)?.toLowerCase() === fid)
    : bullets.filter((b) => b.line === handle.line);
  if (same.length > 1) return phrenErr(`The finding moved in ${where} and now matches ${same.length} lines; locate it again.`, PhrenError.AMBIGUOUS_MATCH);
  if (same.length === 0) return phrenErr(`The finding vanished from ${where} before it could be changed.`, PhrenError.NOT_FOUND);
  if (same[0].line !== handle.line) return phrenErr(`The finding changed in ${where} since it was located; locate it again.`, PhrenError.NOT_FOUND);
  return phrenOk(same[0]);
}

function lineStart(lines: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  return offset;
}

function replaceLine(content: string, lines: string[], index: number, next: string): string {
  const start = lineStart(lines, index);
  return content.slice(0, start) + next + content.slice(start + lines[index].replace(/\r$/, "").length);
}

/**
 * Cut a bullet and its phren:cite line. One neighbouring blank line goes too
 * when the cut would leave two in a row or end the file on a blank line, which
 * is what the whole-file normalisation older writers ran produced at the cut.
 */
function removeBullet(content: string, lines: string[], bullet: Bullet): string {
  const end = content.endsWith("\n") ? lines.length - 1 : lines.length;
  const blank = (i: number): boolean => i >= 0 && i < end && lines[i] === "";
  let from = bullet.lineIndex;
  let to = from + (bullet.citation ? 2 : 1);
  if (blank(from - 1) && blank(to)) to++;
  else if (blank(from - 1) && to >= end) from--;
  if (to < end || content.endsWith("\n")) return content.slice(0, lineStart(lines, from)) + content.slice(lineStart(lines, to));
  // The cut takes a last line that has no newline: drop the newline before it, so the file still ends without one.
  return from === 0 ? "" : content.slice(0, lineStart(lines, from) - (lines[from - 1].endsWith("\r") ? 2 : 1));
}

/**
 * Rewrite one finding's line under the file's lock: re-read the file, find the
 * bullet again by its handle, and write back only `transform(line)`. Returning
 * null removes the bullet and its phren:cite line. Refuses when the bullet
 * vanished, changed, or moved to more than one candidate line since it was
 * located, and when it sits in a read-only legacy archive block.
 */
export function rewriteFindingLine(
  phrenPath: string,
  project: string,
  handle: FindingHandle,
  transform: (line: string) => string | null,
): PhrenResult<RewrittenFinding> {
  if (!isFindingFile(phrenPath, project, handle.file)) {
    return phrenErr(`${handle.file} is not a findings file of "${project}".`, PhrenError.VALIDATION_ERROR);
  }
  const file = path.resolve(handle.file);
  if (!fs.existsSync(file)) return phrenErr(`The finding vanished: ${path.basename(file)} no longer exists.`, PhrenError.NOT_FOUND);
  return withSafeLock(file, () => {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    const found = refind(scanBullets(lines), handle);
    if (!found.ok) return found;
    const bullet = found.data;
    if (bullet.archived) {
      return phrenErr(`The finding sits in a read-only archive block of ${path.basename(file)}.`, PhrenError.VALIDATION_ERROR);
    }
    const next = transform(bullet.line);
    if (next !== null && (!next.startsWith("- ") || /[\r\n]/.test(next))) {
      return phrenErr("A finding stays one bullet line; return null to remove it.", PhrenError.VALIDATION_ERROR);
    }
    if (next !== bullet.line) {
      atomicWriteText(file, next === null ? removeBullet(content, lines, bullet) : replaceLine(content, lines, bullet.lineIndex, next));
    }
    return phrenOk({ file, lineIndex: bullet.lineIndex, before: bullet.line, after: next });
  });
}
