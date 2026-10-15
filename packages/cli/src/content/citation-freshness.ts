import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findPhrenPath, runtimeFile } from "../phren-paths.js";
import { kindFromDomain, parseRemoteUrl } from "../bridge/git-hosts.js";
import { resolveHostToken } from "../bridge/git-host-auth.js";
import type { FindingCitation } from "./citation.js";

export interface CitationFreshness {
  state: "current" | "changed" | "unknown";
  checkedAt: string;
  head?: string;
  lastCommit?: { sha: string; summary: string; authoredAt: string } | null;
}
export interface CitationFreshnessOptions { phrenPath?: string; projectRemote?: string | null }
export type FreshnessCitation = FindingCitation & { projectRemote?: string | null };
interface Target { domain: string; repo: string; commit: string; file: string; key: string }
interface Repository { domain: string; path: string; root?: string }
interface Resolution { checkedAt: string; value: Repository | null }
type CacheEntry = CitationFreshness | Resolution;
type Cache = Record<string, CacheEntry>;
const MINUTE = 60_000;
// Refresh path only. Process spawns on Windows runners often exceed 200 ms.
const GIT_TIMEOUT_MS = 1000;
const RETENTION = 7 * 24 * 60 * MINUTE;
const RESOLUTION_TTL = 24 * 60 * MINUTE;
const cacheMemo = new Map<string, { mtimeMs: number; size: number; entries: Cache }>();
const isChanged = (entry?: CacheEntry): entry is CitationFreshness => !!entry && "state" in entry && entry.state === "changed";
const resolutionKey = (citation: FreshnessCitation, opts: CitationFreshnessOptions) =>
  `repo:${citation.repo ?? ""}\0${citation.projectRemote ?? opts.projectRemote ?? ""}`;
const pending = new Map<string, Promise<void>>();
const off = () => process.env.PHREN_CITATION_FRESHNESS?.trim().toLowerCase() === "off";

function git(root: string | undefined, timeoutMs: number, ...args: string[]): string {
  if (timeoutMs <= 0) return "";
  try {
    return execFileSync("git", [...(root ? ["-C", root] : []), ...args], {
      encoding: "utf8", timeout: Math.max(1, Math.ceil(timeoutMs)), stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

function checkoutRoot(repo: string | undefined, deadline: number): string | undefined {
  if (!repo || !path.isAbsolute(repo)) return;
  try {
    const root = realpathSync(repo);
    const toplevel = git(root, Math.min(GIT_TIMEOUT_MS, deadline - Date.now()), "rev-parse", "--show-toplevel");
    if (!toplevel || !path.isAbsolute(toplevel)) return;
    // Git prints forward slashes and long names on Windows; compare canonical forms.
    const canonical = (value: string) => {
      // The JS realpath keeps 8.3 short names (RUNNER~1); the native one expands them.
      const resolved = path.resolve((realpathSync.native ?? realpathSync)(value));
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return canonical(toplevel) === canonical(root) ? root : undefined;
  } catch { return undefined; }
}

function validDomain(domain: string): boolean {
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::([0-9]+))?$/.exec(domain);
  return !!match && (!match[2] || (Number(match[2]) >= 1 && Number(match[2]) <= 65535));
}

function repository(citation: FreshnessCitation, opts: CitationFreshnessOptions, entries: Cache, deadline: number) {
  const fallback = citation.projectRemote ?? opts.projectRemote;
  const key = resolutionKey(citation, opts);
  const cached = entries[key];
  if (cached && "value" in cached && fresh(cached)) return cached.value;
  const local = checkoutRoot(citation.repo, deadline);
  const read = (...args: string[]) => git(local, Math.min(GIT_TIMEOUT_MS, deadline - Date.now()), ...args);
  const remote = local ? read("remote", "get-url", "origin") : "";
  const parsed = parseRemoteUrl(remote || fallback || "");
  let value = null;
  if (parsed && validDomain(parsed.domain) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.path)
    && !parsed.path.split("/").some(part => part === "." || part === "..")) {
    const override = (remote ? read("config", "--get", "remote.origin.phrenHost") : "")
      || read("config", ...(local ? [] : ["--global"]), "--get", `phren.${parsed.domain}.host`);
    const named = override.trim().toLowerCase();
    const kind = ["github", "gitlab", "gitboy"].includes(named) ? named : kindFromDomain(parsed.domain);
    if (kind === "gitboy") value = { ...parsed, root: remote ? local : undefined };
  }
  // A budget-limited git lookup must not become a day-long negative resolution.
  if (Date.now() < deadline) entries[key] = { checkedAt: new Date().toISOString(), value };
  return value;
}

function target(citation: FreshnessCitation, repo: Repository | null | undefined): Target | undefined {
  if (!citation.file || !citation.commit || !/^[a-f0-9]{7,64}$/i.test(citation.commit)) return;
  let file = citation.file.split(path.sep).join("/");
  if (file.includes("\\") || file.includes("\0") || file.split("/").includes("..")) return;
  if (!repo || !validDomain(repo.domain) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.path)
    || repo.path.split("/").some(part => part === "." || part === "..")) return;
  if (path.isAbsolute(file)) {
    if (!repo.root || !path.isAbsolute(repo.root)) return;
    // git canonicalizes macOS /var and other checkout aliases; citations may retain the alias.
    const absolute = citation.repo && path.isAbsolute(citation.repo)
      ? path.resolve(repo.root, path.relative(citation.repo, file)) : file;
    file = path.relative(repo.root, absolute).split(path.sep).join("/");
    if (file === ".." || file.startsWith("../") || path.isAbsolute(file)) return;
  }
  file = path.posix.normalize(file);
  if (!file || file === "." || file.startsWith("../")) return;
  const result = { domain: repo.domain, repo: repo.path, commit: citation.commit, file };
  return { ...result, key: JSON.stringify([result.domain, result.repo, result.commit, file]) };
}

function cacheFile(opts: CitationFreshnessOptions): string | undefined {
  const root = opts.phrenPath ?? findPhrenPath();
  return root ? runtimeFile(root, "citation-freshness.json") : undefined;
}

function readCache(file?: string): Cache {
  if (!file) return {};
  try {
    const info = statSync(file);
    const memo = cacheMemo.get(file);
    if (memo && memo.mtimeMs === info.mtimeMs && memo.size === info.size) return memo.entries;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Cache;
    const entries = Object.fromEntries(Object.entries(raw).filter(([key, value]) => value
      && Number.isFinite(Date.parse(value.checkedAt))
      && (key.startsWith("repo:") ? "value" in value : "state" in value && ["current", "changed", "unknown"].includes(value.state))));
    rememberCache(file, entries, info);
    return entries;
  } catch { cacheMemo.delete(file); return {}; }
}

function rememberCache(file: string, entries: Cache, info = statSync(file)): void {
  const { mtimeMs, size } = info;
  if (cacheMemo.size >= 64) cacheMemo.delete(cacheMemo.keys().next().value!);
  cacheMemo.set(file, { mtimeMs, size, entries });
}

function ttl(value: CacheEntry): number {
  return "value" in value ? RESOLUTION_TTL : (value.state === "changed" ? 60 : value.state === "current" ? 15 : 5) * MINUTE;
}
function fresh(value?: CacheEntry): boolean {
  return !!value && Date.now() - Date.parse(value.checkedAt) < ttl(value);
}
function save(file: string | undefined, entries: Cache): void {
  if (!file) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const previous = readCache(file);
    const merged = { ...previous, ...entries };
    for (const [key, value] of Object.entries(previous)) {
      const incoming = entries[key];
      if (Date.now() - Date.parse(value.checkedAt) > ("value" in value ? RESOLUTION_TTL : RETENTION)) continue;
      if (!incoming || (isChanged(value) && !isChanged(incoming))
        || (isChanged(value) === isChanged(incoming) && Date.parse(value.checkedAt) > Date.parse(incoming.checkedAt))) merged[key] = value;
    }
    const sorted = Object.entries(merged).filter(([, value]) =>
      Date.now() - Date.parse(value.checkedAt) <= ("value" in value ? RESOLUTION_TTL : RETENTION)).sort((a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt)).slice(0, 5000);
    const saved = Object.fromEntries(sorted);
    writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
    renameSync(temp, file);
    rememberCache(file, saved);
  } catch { /* Cache failures never fail retrieval. */ }
  finally { try { unlinkSync(temp); } catch { /* Already renamed. */ } }
}

/** Reads persisted resolutions and checks only; never runs git or accesses the network. Changed evidence survives refresh failures for seven days. */
export function cachedCitationFreshness(citation: FreshnessCitation, opts: CitationFreshnessOptions = {}): CitationFreshness | undefined {
  if (off()) return;
  try {
    const entries = readCache(cacheFile(opts));
    const resolution = entries[resolutionKey(citation, opts)];
    if (!resolution || !("value" in resolution) || !fresh(resolution)) return;
    const resolved = target(citation, resolution.value);
    const value = resolved ? entries[resolved.key] : undefined;
    return value && "state" in value && Date.now() - Date.parse(value.checkedAt) <= RETENTION
      && (isChanged(value) || fresh(value)) ? value : undefined;
  } catch { return undefined; }
}

interface RefreshOptions extends CitationFreshnessOptions { budgetMs: number; signal?: AbortSignal; fetchImpl?: typeof fetch }

function answer(raw: unknown, head: unknown, checkedAt: string): CitationFreshness {
  const row = raw as { changed?: unknown; head?: unknown; last_commit?: { sha?: unknown; summary?: unknown; authored_at?: unknown } | null } | undefined;
  if (typeof row?.changed !== "boolean") return { state: "unknown", checkedAt };
  const last = row.last_commit;
  return { state: row.changed ? "changed" : "current", checkedAt,
    ...(typeof (row.head ?? head) === "string" ? { head: (row.head ?? head) as string } : {}),
    ...(row.changed ? { lastCommit: last && typeof last.sha === "string" && typeof last.summary === "string" && typeof last.authored_at === "string"
      ? { sha: last.sha, summary: last.summary, authoredAt: last.authored_at } : null } : {}) };
}

async function request(batch: Target[], opts: RefreshOptions, remaining: number, entries: Cache): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const first = batch[0];
    if (!validDomain(first.domain)) throw new Error("Invalid git host");
    const url = new URL("https://" + first.domain);
    url.pathname = `/api/v1/repos/${first.repo.split("/").map(encodeURIComponent).join("/")}/changed`;
    const token = await resolveHostToken("gitboy", first.domain);
    if (controller.signal.aborted) throw new Error("Aborted");
    url.searchParams.set("since", first.commit);
    for (const item of batch) url.searchParams.append("path", item.file);
    const response = await (opts.fetchImpl ?? fetch)(url, { redirect: "manual", signal: controller.signal,
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token.token}` } : {}) } });
    if (!response.ok) throw new Error("Host could not answer");
    return await response.json() as { head?: unknown; paths?: Array<{ path?: string }> };
  };
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort(); reject(new Error("Deadline")); }, Math.max(1, Math.min(remaining, 5000)));
      controller.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
    const body = await Promise.race([work(), expired]);
    if (controller.signal.aborted) throw new Error("Aborted");
    const checkedAt = new Date().toISOString();
    for (const item of batch) {
      const value = answer(Array.isArray(body.paths) ? body.paths.find(row => row.path === item.file) : undefined, body.head, checkedAt);
      if (!isChanged(entries[item.key]) || value.state === "changed") entries[item.key] = value;
    }
  } catch {
    for (const item of batch) if (!isChanged(entries[item.key])) entries[item.key] = { state: "unknown", checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

/** Best effort, bounded, and deduplicated per cache key, including background Hook polls. */
export async function refreshCitationFreshness(citations: readonly FreshnessCitation[], opts: RefreshOptions): Promise<Map<FreshnessCitation, CitationFreshness>> {
  const result = new Map<FreshnessCitation, CitationFreshness>();
  if (off()) return result;
  try {
    const deadline = Date.now() + Math.max(0, opts.budgetMs);
    const file = cacheFile(opts), entries = { ...readCache(file) };
    const resolved = new Map<FreshnessCitation, Target>();
    const groups = new Map<string, Map<string, Target>>();
    for (const citation of citations) {
      const item = target(citation, repository(citation, opts, entries, deadline));
      if (!item) continue;
      resolved.set(citation, item);
      if (fresh(entries[item.key])) continue;
      const groupKey = JSON.stringify([item.domain, item.repo, item.commit]);
      if (!groups.has(groupKey)) groups.set(groupKey, new Map());
      groups.get(groupKey)!.set(item.key, item);
    }
    for (const group of groups.values()) {
      const items = [...group.values()];
      for (let i = 0; i < items.length; i += 100) {
        const batch = items.slice(i, i + 100).filter(item => !pending.has(`${file}:${item.key}`));
        const remaining = deadline - Date.now();
        if (remaining <= 0 || opts.signal?.aborted) {
          for (const item of items.slice(i)) if (!isChanged(entries[item.key])) entries[item.key] = { state: "unknown", checkedAt: new Date().toISOString() };
          break;
        }
        if (!batch.length) continue;
        const work = request(batch, opts, remaining, entries).then(() => save(file, entries));
        for (const item of batch) pending.set(`${file}:${item.key}`, work);
        try { await work; } finally { for (const item of batch) pending.delete(`${file}:${item.key}`); }
      }
    }
    save(file, entries);
    const latest = { ...entries, ...readCache(file) };
    for (const [citation, item] of resolved) {
      const value = latest[item.key];
      if (value && "state" in value) result.set(citation, value);
    }
  } catch { /* Offline, invalid citations and disk failures must never fail retrieval. */ }
  return result;
}

export function citationFreshnessAnnotation(citation: FindingCitation, value?: CitationFreshness): string {
  if (value?.state !== "changed") return "";
  const clean = (text: string) => text.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 300);
  const detail = value.lastCommit ? `changed in ${clean(value.lastCommit.sha).slice(0, 7)} "${clean(value.lastCommit.summary)}"` : "changed since cited";
  return ` [may be out of date: ${clean(citation.file ?? "file")} ${detail}]`;
}
