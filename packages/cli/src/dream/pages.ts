/**
 * Pages: one markdown file per subject under `<store>/<project>/reference/pages/<slug>.md`.
 *
 * Dreaming writes these instead of growing shared files (one page per subject
 * beats a big FINDINGS.md). A page is frontmatter (`title`, `summary`), then a
 * body that links other pages as `[[slug]]` and cites findings as `fid:xxxxxxxx`.
 *
 * Search needs no extra wiring: the indexer globs every `**\/*.md` in a project
 * (DEFAULT_INDEX_POLICY.includeGlobs) and `classifyFile` types anything under a
 * `reference/` segment as `reference`, so a page is found like any archive doc
 * on the next index build.
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteText } from "../phren-paths.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { withFileLock } from "../shared/governance.js";
import { appendAuditLog } from "../shared.js";

export const PAGES_DIR = path.join("reference", "pages");
/** A page is a summary of one subject, not an archive. Larger pages are refused. */
export const MAX_PAGE_BYTES = 16 * 1024;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LINK_RE = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g;
const FID_RE = /\bfid:([a-f0-9]{8})\b/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class PageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageError";
  }
}

export interface PageMeta {
  slug: string;
  title: string;
  summary: string;
  /** Page slugs this page links to (`[[slug]]`), deduplicated, in order of appearance. */
  links: string[];
  /** Finding ids the page cites (`fid:xxxxxxxx`). */
  fids: string[];
  path: string;
}

export interface Page extends PageMeta {
  body: string;
  markdown: string;
}

export function isValidPageSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Accepts a bare slug or the changeset's page reference (`reference/pages/<slug>.md`)
 * and returns the slug. Throws on anything else, including traversal attempts.
 */
export function pageSlug(ref: string): string {
  const trimmed = ref.trim().replace(/\\/g, "/");
  const m = trimmed.match(/^(?:reference\/pages\/)?([^/]+?)(?:\.md)?$/);
  const slug = m?.[1] ?? "";
  if (!isValidPageSlug(slug)) {
    throw new PageError(`Invalid page "${ref}": a slug is lowercase letters, digits and dashes, at most 64 characters.`);
  }
  return slug;
}

function pagesDir(store: string, project: string): string {
  const dir = storeAwareProjectPath(store, project, PAGES_DIR);
  const projectDir = storeAwareProjectPath(store, project);
  if (!dir || !projectDir || !fs.existsSync(projectDir)) throw new PageError(`Project "${project}" not found in phren.`);
  return dir;
}

function parseFrontmatter(markdown: string): { fields: Record<string, string>; body: string } {
  const m = markdown.match(FRONTMATTER_RE);
  if (!m) return { fields: {}, body: markdown };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = unquote(kv[2].trim());
  }
  return { fields, body: markdown.slice(m[0].length) };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function frontmatterValue(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return /[:#"'\[\]{}]|^[-?!&*|>%@`]/.test(flat) ? JSON.stringify(flat) : flat;
}

/** `[[slug]]` targets in a body, deduplicated. Invalid targets are kept verbatim so the link check reports them. */
export function extractPageLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) seen.add(m[1].trim());
  return [...seen];
}

export function extractPageFids(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(FID_RE)) seen.add(m[1]);
  return [...seen];
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1].trim();
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (text && !text.startsWith("#")) return text.replace(/\s+/g, " ").slice(0, 200);
  }
  return "";
}

function parsePage(slug: string, file: string, markdown: string): Page {
  const { fields, body } = parseFrontmatter(markdown);
  return {
    slug,
    title: fields.title || firstHeading(body) || slug,
    summary: fields.summary || firstParagraph(body),
    links: extractPageLinks(body),
    fids: extractPageFids(body),
    path: file,
    body,
    markdown,
  };
}

/**
 * Puts the markdown in page shape: frontmatter with a title and a summary
 * (taken from the model's frontmatter, else the first heading and paragraph),
 * an `updated` date, and the body. `links` the caller declares but the body
 * does not mention are appended as a "Related" line so they stay visible.
 */
export function normalizePage(slug: string, markdown: string, links: string[], now = new Date()): string {
  const { fields, body: rawBody } = parseFrontmatter(markdown.replace(/\r\n/g, "\n"));
  let body = rawBody.trim();
  const title = fields.title || firstHeading(body) || slug;
  const summary = fields.summary || firstParagraph(body);
  const inBody = new Set(extractPageLinks(body));
  const extra = links.map((l) => l.trim()).filter((l) => l && !inBody.has(l) && l !== slug);
  if (extra.length) body += `\n\nRelated: ${[...new Set(extra)].map((l) => `[[${l}]]`).join(", ")}`;
  const head = [
    "---",
    `title: ${frontmatterValue(title)}`,
    `summary: ${frontmatterValue(summary)}`,
    `updated: ${now.toISOString().slice(0, 10)}`,
    "---",
  ].join("\n");
  return `${head}\n\n${body}\n`;
}

export function listPages(store: string, project: string): PageMeta[] {
  const dir = pagesDir(store, project);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const pages: PageMeta[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -3);
    if (!isValidPageSlug(slug)) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      const { body: _body, markdown: _markdown, ...meta } = parsePage(slug, file, fs.readFileSync(file, "utf8"));
      pages.push(meta);
    } catch { /* unreadable page: skip */ }
  }
  return pages;
}

export function readPage(store: string, project: string, slugOrRef: string): Page | null {
  const slug = pageSlug(slugOrRef);
  const file = path.join(pagesDir(store, project), `${slug}.md`);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return parsePage(slug, file, fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Writes (creates or replaces) one page. The write is locked and atomic and
 * goes to the audit log. Broken links do not stop the write; they are returned
 * so the caller can record them beside the change.
 */
export async function writePage(
  store: string,
  project: string,
  slug: string,
  markdown: string,
  links: string[],
): Promise<{ path: string; brokenLinks: string[] }> {
  const clean = pageSlug(slug);
  const dir = pagesDir(store, project);
  const content = normalizePage(clean, markdown, links);
  if (Buffer.byteLength(content, "utf8") > MAX_PAGE_BYTES) {
    throw new PageError(`Page "${clean}" is over ${MAX_PAGE_BYTES / 1024} KB; split it into smaller subjects.`);
  }
  const file = path.join(dir, `${clean}.md`);
  fs.mkdirSync(dir, { recursive: true });
  withFileLock(file, () => {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new PageError(`Refusing to write through a symlink at ${file}.`);
    } catch (err) {
      if (err instanceof PageError) throw err;
    }
    atomicWriteText(file, content);
  });
  appendAuditLog(store, "write_page", `project=${project} page=${clean}`);
  const existing = new Set(listPages(store, project).map((p) => p.slug));
  const brokenLinks = extractPageLinks(parseFrontmatter(content).body).filter((l) => !existing.has(l));
  return { path: file, brokenLinks };
}

export interface PageLinkReport {
  slug: string;
  /** `[[target]]` links with no page (or an invalid slug). */
  brokenLinks: string[];
  /** Cited fids that are not in the given set of known finding ids. Empty when no set is given. */
  unknownFids: string[];
}

/** Link check across every page of a project. Only pages with a problem are returned. */
export function checkPageLinks(store: string, project: string, knownFids?: Iterable<string>): PageLinkReport[] {
  const pages = listPages(store, project);
  const slugs = new Set(pages.map((p) => p.slug));
  const fids = knownFids ? new Set(knownFids) : null;
  const reports: PageLinkReport[] = [];
  for (const page of pages) {
    const brokenLinks = page.links.filter((l) => !slugs.has(l));
    const unknownFids = fids ? page.fids.filter((f) => !fids.has(f)) : [];
    if (brokenLinks.length || unknownFids.length) reports.push({ slug: page.slug, brokenLinks, unknownFids });
  }
  return reports;
}
