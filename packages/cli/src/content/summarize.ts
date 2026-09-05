/**
 * Give the archive a shape.
 *
 * Findings age out of FINDINGS.md into reference/topics/<topic>.md, append-only,
 * grouped under "## Archived <date>" headings. A store a year old carries
 * hundreds of thousands of words there, reachable only by keyword: search finds
 * bullet 312, and nothing says what the topic amounts to. This writes a "## Now"
 * block at the top of each topic file — structural by default (counts, tags,
 * what is mentioned most, the newest headlines), a prose paragraph when an LLM
 * is configured — and a "What phren knows" block at the end of summary.md that
 * the prompt hook injects once per session for the project at hand. Both live
 * between markers, so re-running replaces rather than accumulates. Nothing in
 * the archive itself is rewritten; a topic file past a size cap is split, oldest
 * sections first, into <topic>.older.md.
 */

import * as fs from "fs";
import * as path from "path";
import { callLlm } from "./dedup.js";
import { readProjectTopics, topicReferencePath } from "../project-topics.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { atomicWriteText, debugLog } from "../phren-paths.js";
import { errorMessage } from "../utils.js";

export const NOW_START = "<!-- phren:now:start -->";
export const NOW_END = "<!-- phren:now:end -->";
export const KNOWS_START = "<!-- phren:knows:start -->";
export const KNOWS_END = "<!-- phren:knows:end -->";
/** Bullets a topic file may hold before the oldest sections move to <topic>.older.md. */
export const TOPIC_SPLIT_AT = 400;

export interface ArchivedBullet { date: string; tag: string; text: string }

export interface TopicDigest {
  slug: string;
  file: string;
  bullets: number;
  tags: Record<string, number>;
  first: string;
  last: string;
  mentioned: string[];
  headlines: string[];
}

/** Every "- " bullet under an "## Archived <date>" heading (or before any heading, for legacy files). */
export function parseTopicBullets(content: string): ArchivedBullet[] {
  const out: ArchivedBullet[] = [];
  let date = "";
  let inNow = false;
  for (const raw of content.split("\n")) {
    if (raw.startsWith(NOW_START)) { inNow = true; continue; }
    if (raw.startsWith(NOW_END)) { inNow = false; continue; }
    if (inNow) continue;
    const heading = /^## Archived (\d{4}-\d{2}-\d{2})/.exec(raw);
    if (heading) { date = heading[1]; continue; }
    if (raw.startsWith("## ")) { continue; }
    if (!raw.startsWith("- ")) continue;
    const body = raw.slice(2).replace(/<!--.*?-->/g, "").trim();
    const tagMatch = /^\[([a-z][a-z-]*)(?::[^\]]*)?\]\s*/.exec(body);
    out.push({ date, tag: tagMatch ? tagMatch[1] : "untagged", text: tagMatch ? body.slice(tagMatch[0].length) : body });
  }
  return out;
}

const STOP = new Set(["The", "This", "That", "When", "Then", "There", "These", "Those", "With", "Without", "After", "Before", "Also", "Note", "Never", "Always", "Every", "Each", "Only", "Both", "Some", "Most", "Many", "Much", "More", "Less", "Use", "Used", "Using", "Run", "Runs", "Make", "Made", "Keep", "Kept", "Set", "Sets", "Got", "Get", "Gets", "Does", "Did", "Not", "For", "And", "But", "Any", "All", "Its", "Our", "Your", "Their", "One", "Two", "Three", "First", "Last", "New", "Old", "Fix", "Fixed", "Add", "Added", "Remove", "Removed", "Check", "Rails", "Node", "React", "Python", "TypeScript", "JSON", "YAML", "HTML", "CSS", "API", "URL", "ID", "OK", "TODO", "NOTE", "DO", "NOT"]);

/** Names the bullets keep coming back to: backticked identifiers and CamelCase words. ALLCAPS is emphasis, not a name. */
export function mostMentioned(bullets: ArchivedBullet[], limit = 6): string[] {
  const counts = new Map<string, number>();
  for (const b of bullets) {
    const seen = new Set<string>();
    for (const m of b.text.matchAll(/`([A-Za-z_][\w./-]{2,40})`|\b([A-Z][a-z]+(?:[A-Z][a-z0-9]+)+)\b/g)) {
      const term = (m[1] ?? m[2] ?? "").trim();
      if (/^[A-Z0-9_]+$/.test(term)) continue;
      if (!term || STOP.has(term) || seen.has(term)) continue;
      seen.add(term);
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([t]) => t);
}

function headline(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[.;:](\s|$)/);
  const s = cut > 30 && cut < max ? flat.slice(0, cut) : flat;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function digestTopic(slug: string, file: string, bullets: ArchivedBullet[]): TopicDigest {
  const tags: Record<string, number> = {};
  for (const b of bullets) tags[b.tag] = (tags[b.tag] ?? 0) + 1;
  const dates = bullets.map((b) => b.date).filter(Boolean).sort();
  const newest = [...bullets].reverse().filter((b) => b.date).slice(0, 5);
  return {
    slug,
    file,
    bullets: bullets.length,
    tags,
    first: dates[0] ?? "",
    last: dates[dates.length - 1] ?? "",
    mentioned: mostMentioned(bullets),
    headlines: newest.map((b) => headline(b.text)),
  };
}

function plural(n: number, word: string): string {
  if (word === "context") return `${n} context note${n === 1 ? "" : "s"}`;
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The paragraph that can always be written, no model required. */
export function structuralNow(d: TopicDigest): string {
  if (!d.bullets) return "Nothing archived under this topic yet.";
  const span = d.first && d.last ? (d.first === d.last ? `archived on ${d.first}` : `archived between ${d.first} and ${d.last}`) : "";
  const tagLine = Object.entries(d.tags).filter(([t]) => t !== "untagged").sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => plural(n, t)).join(", ");
  const parts = [`${plural(d.bullets, "finding")}${span ? `, ${span}` : ""}${tagLine ? `: ${tagLine}` : ""}.`];
  if (d.mentioned.length) parts.push(`Keeps coming back to ${d.mentioned.join(", ")}.`);
  if (d.headlines.length) parts.push(`Newest: ${d.headlines.map((h, i) => `(${i + 1}) ${h}`).join(" ")}`);
  return parts.join(" ");
}

/** A prose paragraph over the newest bullets, when a model is configured; "" otherwise. */
export async function proseNow(d: TopicDigest, bullets: ArchivedBullet[], signal?: AbortSignal): Promise<string> {
  const newest = [...bullets].reverse().slice(0, 60).map((b) => `- [${b.tag}] ${b.text}`).join("\n");
  const prompt = `These are archived engineering findings for the topic "${d.slug}" of one software project, newest first. Write one paragraph of 4 to 6 plain sentences stating what is currently known: the standing decisions, the pitfalls that still apply, and the patterns in use. Be concrete, name the components involved, no preamble, no bullet points.\n\n${newest}`;
  try {
    const text = (await callLlm(prompt, signal, 320)).trim();
    return text.length > 40 ? text : "";
  } catch (err: unknown) {
    debugLog(`summarize: llm failed: ${errorMessage(err)}`);
    return "";
  }
}

function block(start: string, end: string, heading: string, body: string, stamp: string): string {
  return `${start.replace("-->", `at=${stamp} -->`)}\n${heading}\n\n${body}\n${end}`;
}

/** Insert or replace a marked block. Topic files: before the first section; summary: at the end. */
export function upsertBlock(content: string, start: string, end: string, rendered: string, where: "top" | "bottom"): string {
  const startRe = new RegExp(`${start.replace("-->", "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*-->`);
  const s = content.search(startRe);
  const e = content.indexOf(end);
  if (s !== -1 && e !== -1 && e > s) {
    return `${content.slice(0, s)}${rendered}${content.slice(e + end.length)}`;
  }
  if (where === "top") {
    const firstSection = content.search(/^## /m);
    if (firstSection === -1) return `${content.trimEnd()}\n\n${rendered}\n`;
    return `${content.slice(0, firstSection).trimEnd()}\n\n${rendered}\n\n${content.slice(firstSection)}`;
  }
  return `${content.trimEnd()}\n\n${rendered}\n`;
}

/** The stamp inside an existing block, so unchanged files are not rewritten. */
export function blockStamp(content: string, start: string): string | null {
  const m = new RegExp(`${start.replace("-->", "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}at=([^ ]+) -->`).exec(content);
  return m ? m[1] : null;
}

export interface SummarizeOptions {
  /** Ask a configured model for prose; falls back to structural when none answers. */
  llm?: boolean;
  /** Re-summarize even when the file has not changed since the last block. */
  force?: boolean;
  now?: () => Date;
}

export interface TopicResult { slug: string; file: string; bullets: number; updated: boolean; split?: string; now: string }

/**
 * Move whole "## Archived <date>" sections, oldest first, into <topic>.older.md
 * until the file is under the cap. Returns the older file's path if anything moved.
 */
export function splitTopicFile(filePath: string, maxBullets = TOPIC_SPLIT_AT): string | null {
  const content = fs.readFileSync(filePath, "utf8");
  if (parseTopicBullets(content).length <= maxBullets) return null;
  const lines = content.split("\n");
  // Section boundaries: every "## Archived <date>" line, in file order (which is oldest first).
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (/^## Archived \d{4}-\d{2}-\d{2}/.test(lines[i])) starts.push(i);
  if (starts.length < 2) return null;
  const sections = starts.map((s, i) => lines.slice(s, i + 1 < starts.length ? starts[i + 1] : lines.length));
  const head = lines.slice(0, starts[0]);
  let keep = sections.slice();
  const moved: string[][] = [];
  const count = (secs: string[][]) => secs.reduce((n, sec) => n + sec.filter((l) => l.startsWith("- ")).length, 0);
  while (keep.length > 1 && count(keep) > maxBullets) moved.push(keep.shift()!);
  if (!moved.length) return null;
  const olderPath = filePath.replace(/\.md$/, ".older.md");
  const title = head.find((l) => l.startsWith("# ")) ?? "# archive";
  const prior = fs.existsSync(olderPath) ? fs.readFileSync(olderPath, "utf8").trimEnd() + "\n\n" : `${title} (older archive)\n\nSections moved here from ${path.basename(filePath)} once it passed ${maxBullets} bullets. Still indexed; still searchable.\n\n`;
  atomicWriteText(olderPath, prior + moved.map((sec) => sec.join("\n").trimEnd()).join("\n\n") + "\n");
  atomicWriteText(filePath, [...head, ...keep.flat()].join("\n").trimEnd() + "\n");
  return olderPath;
}

export async function summarizeTopicFile(filePath: string, slug: string, opts: SummarizeOptions = {}): Promise<TopicResult> {
  const split = splitTopicFile(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const stat = fs.statSync(filePath);
  const stamp = (opts.now ?? (() => new Date()))().toISOString();
  const prev = blockStamp(content, NOW_START);
  const bullets = parseTopicBullets(content);
  const digest = digestTopic(slug, filePath, bullets);
  // The block records when it was written; a file untouched since then is left alone.
  if (!opts.force && prev && !split && new Date(prev).getTime() >= stat.mtimeMs - 1000) {
    const existing = content.slice(content.indexOf(NOW_START.replace("-->", "")), content.indexOf(NOW_END));
    return { slug, file: filePath, bullets: bullets.length, updated: false, now: existing.split("\n").slice(2).join("\n").trim() };
  }
  let now = "";
  if (opts.llm) now = await proseNow(digest, bullets, AbortSignal.timeout(25_000));
  if (!now) now = structuralNow(digest);
  const next = upsertBlock(content, NOW_START, NOW_END, block(NOW_START, NOW_END, "## Now", now, stamp), "top");
  if (next !== content) atomicWriteText(filePath, next);
  return { slug, file: filePath, bullets: bullets.length, updated: next !== content, split: split ?? undefined, now };
}

export interface ProjectSummary { project: string; topics: TopicResult[]; summaryPath: string | null; summaryUpdated: boolean }

function countActiveFindingsIn(findingsPath: string): number {
  try {
    let inArchive = false;
    let n = 0;
    for (const line of fs.readFileSync(findingsPath, "utf8").split("\n")) {
      if (/<!--\s*phren:archive:start/.test(line) || line.startsWith("<details")) inArchive = true;
      if (/<!--\s*phren:archive:end/.test(line) || line.startsWith("</details")) inArchive = false;
      if (!inArchive && line.startsWith("- ")) n++;
    }
    return n;
  } catch { return 0; }
}

function countOpenTasks(tasksPath: string): number {
  try { return fs.readFileSync(tasksPath, "utf8").split("\n").filter((l) => /^- \[ \]/.test(l)).length; } catch { return 0; }
}

/** Summarize every topic file of a project and refresh the "What phren knows" block in summary.md. */
export async function summarizeProject(phrenPath: string, project: string, opts: SummarizeOptions = {}): Promise<ProjectSummary> {
  const topics = readProjectTopics(phrenPath, project).topics;
  const results: TopicResult[] = [];
  const seen = new Set<string>();
  for (const topic of topics) {
    const file = topicReferencePath(phrenPath, project, topic.slug);
    if (!file || seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    results.push(await summarizeTopicFile(file, topic.slug, opts));
  }
  // Topic files that exist but are not in the configured topic list still count.
  const topicsDir = storeAwareProjectPath(phrenPath, project, "reference", "topics");
  if (topicsDir && fs.existsSync(topicsDir)) {
    for (const entry of fs.readdirSync(topicsDir)) {
      if (!entry.endsWith(".md") || entry.endsWith(".older.md")) continue;
      const file = path.join(topicsDir, entry);
      if (seen.has(file)) continue;
      seen.add(file);
      results.push(await summarizeTopicFile(file, entry.replace(/\.md$/, ""), opts));
    }
  }
  const summaryPath = storeAwareProjectPath(phrenPath, project, "summary.md");
  if (!summaryPath) return { project, topics: results, summaryPath: null, summaryUpdated: false };
  const findingsPath = storeAwareProjectPath(phrenPath, project, "FINDINGS.md");
  const tasksPath = storeAwareProjectPath(phrenPath, project, "tasks.md");
  const active = findingsPath ? countActiveFindingsIn(findingsPath) : 0;
  const archived = results.reduce((n, r) => n + r.bullets, 0);
  const open = tasksPath ? countOpenTasks(tasksPath) : 0;
  const lines = [`- ${plural(active, "active finding")}, ${archived} archived across ${plural(results.filter((r) => r.bullets > 0).length, "topic")}, ${plural(open, "open task")}.`];
  for (const r of results.filter((r) => r.bullets > 0).sort((a, b) => b.bullets - a.bullets)) {
    const first = r.now.split(/(?<=\.)\s/)[0] ?? r.now;
    lines.push(`- **${r.slug}** — ${first}`);
  }
  const stamp = (opts.now ?? (() => new Date()))().toISOString();
  const rendered = block(KNOWS_START, KNOWS_END, "## What phren knows", lines.join("\n"), stamp);
  const existing = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : `# ${project}\n`;
  const next = upsertBlock(existing, KNOWS_START, KNOWS_END, rendered, "bottom");
  const stripStamp = (s: string) => s.replace(/ at=[^ ]+ -->/g, " -->");
  const changed = stripStamp(next) !== stripStamp(existing);
  if (changed) atomicWriteText(summaryPath, next);
  return { project, topics: results, summaryPath, summaryUpdated: changed };
}

/** The "What phren knows" block of a project, for the hook to inject; null when absent. */
export function readKnowsBlock(phrenPath: string, project: string): { path: string; text: string } | null {
  const summaryPath = storeAwareProjectPath(phrenPath, project, "summary.md");
  if (!summaryPath || !fs.existsSync(summaryPath)) return null;
  const content = fs.readFileSync(summaryPath, "utf8");
  const s = content.indexOf(KNOWS_START.replace("-->", ""));
  const e = content.indexOf(KNOWS_END);
  if (s === -1 || e === -1) return null;
  const inner = content.slice(s, e).split("\n").slice(1).join("\n").trim();
  return inner ? { path: summaryPath, text: inner } : null;
}
