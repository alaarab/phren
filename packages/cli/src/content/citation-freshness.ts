import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
type Cache = Record<string, CitationFreshness>;
const MINUTE = 60_000;
const RETENTION = 7 * 24 * 60 * MINUTE;
const resolutions = new Map<string, { at: number; value: { domain: string; path: string; root?: string } | null }>();
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

function repository(citation: FreshnessCitation, opts: CitationFreshnessOptions, deadline = Infinity) {
  const fallback = citation.projectRemote ?? opts.projectRemote;
  const key = JSON.stringify([citation.repo, fallback]);
  const cached = resolutions.get(key);
  if (cached && Date.now() - cached.at < MINUTE) return cached.value;
  const local = citation.repo && existsSync(citation.repo) ? citation.repo : undefined;
  const read = (...args: string[]) => git(local, Math.min(200, deadline - Date.now()), ...args);
  const remote = local ? read("remote", "get-url", "origin") : "";
  const parsed = parseRemoteUrl(remote || fallback || "");
  let value = null;
  if (parsed && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.path)
    && !parsed.path.split("/").some(part => part === "." || part === "..")) {
    const override = (remote ? read("config", "--get", "remote.origin.phrenHost") : "")
      || read("config", "--get", `phren.${parsed.domain}.host`);
    const named = override.trim().toLowerCase();
    const kind = ["github", "gitlab", "gitboy"].includes(named) ? named : kindFromDomain(parsed.domain);
    if (kind === "gitboy") value = { ...parsed, root: remote ? read("rev-parse", "--show-toplevel") || local : citation.repo };
  }
  if (resolutions.size >= 5000) resolutions.delete(resolutions.keys().next().value!);
  resolutions.set(key, { at: Date.now(), value });
  return value;
}

function target(citation: FreshnessCitation, opts: CitationFreshnessOptions, deadline = Infinity): Target | undefined {
  if (!citation.file || !citation.commit || !/^[a-f0-9]{7,64}$/i.test(citation.commit)) return;
  if (citation.file.includes("\\") || citation.file.includes("\0") || citation.file.split("/").includes("..")) return;
  const repo = repository(citation, opts, deadline);
  if (!repo) return;
  let file = citation.file;
  if (path.isAbsolute(file)) {
    if (!repo.root || !path.isAbsolute(repo.root)) return;
    // git canonicalizes macOS /var and other checkout aliases; citations may retain the alias.
    const absolute = citation.repo && existsSync(citation.repo)
      ? path.resolve(realpathSync(citation.repo), path.relative(citation.repo, file)) : file;
    file = path.relative(repo.root, absolute);
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
    const raw = JSON.parse(readFileSync(file, "utf8")) as Cache;
    return Object.fromEntries(Object.entries(raw).filter(([, entry]) => {
      const value = entry as CitationFreshness;
      return value && ["current", "changed", "unknown"].includes(value.state)
        && Number.isFinite(Date.parse(value.checkedAt)) && Date.now() - Date.parse(value.checkedAt) <= RETENTION;
    }));
  } catch { return {}; }
}

function ttl(value: CitationFreshness): number {
  return (value.state === "changed" ? 60 : value.state === "current" ? 15 : 5) * MINUTE;
}
function fresh(value?: CitationFreshness): boolean {
  return !!value && Date.now() - Date.parse(value.checkedAt) < ttl(value);
}
function save(file: string | undefined, entries: Cache): void {
  if (!file) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const previous = readCache(file);
    const merged = { ...previous, ...entries };
    for (const [key, value] of Object.entries(previous)) {
      if (value.state === "changed" && merged[key]?.state !== "changed") merged[key] = value;
    }
    const sorted = Object.entries(merged).sort((a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt)).slice(0, 5000);
    writeFileSync(temp, JSON.stringify(Object.fromEntries(sorted)), { mode: 0o600 });
    renameSync(temp, file);
  } catch { /* Cache failures never fail retrieval. */ }
  finally { try { unlinkSync(temp); } catch { /* Already renamed. */ } }
}

/** Synchronous and network-free. Changed evidence survives refresh failures for seven days. */
export function cachedCitationFreshness(citation: FreshnessCitation, opts: CitationFreshnessOptions = {}): CitationFreshness | undefined {
  if (off()) return;
  try {
    const resolved = target(citation, opts);
    const value = resolved ? readCache(cacheFile(opts))[resolved.key] : undefined;
    return value && (value.state === "changed" || fresh(value)) ? value : undefined;
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
    const token = await resolveHostToken("gitboy", first.domain);
    if (controller.signal.aborted) throw new Error("Aborted");
    const url = new URL(`https://${first.domain}/api/v1/repos/${first.repo.split("/").map(encodeURIComponent).join("/")}/changed`);
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
      if (entries[item.key]?.state !== "changed" || value.state === "changed") entries[item.key] = value;
    }
  } catch {
    for (const item of batch) if (entries[item.key]?.state !== "changed") entries[item.key] = { state: "unknown", checkedAt: new Date().toISOString() };
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
    const file = cacheFile(opts), entries = readCache(file);
    const resolved = new Map<FreshnessCitation, Target>();
    const groups = new Map<string, Map<string, Target>>();
    for (const citation of citations) {
      const item = target(citation, opts, deadline);
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
          for (const item of items.slice(i)) if (entries[item.key]?.state !== "changed") entries[item.key] = { state: "unknown", checkedAt: new Date().toISOString() };
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
    for (const [citation, item] of resolved) if (latest[item.key]) result.set(citation, latest[item.key]);
  } catch { /* Offline, invalid citations and disk failures must never fail retrieval. */ }
  return result;
}

export function citationFreshnessAnnotation(citation: FindingCitation, value?: CitationFreshness): string {
  if (value?.state !== "changed") return "";
  const clean = (text: string) => text.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 300);
  const detail = value.lastCommit ? `changed in ${clean(value.lastCommit.sha).slice(0, 7)} "${clean(value.lastCommit.summary)}"` : "changed since cited";
  return ` [may be out of date: ${clean(citation.file ?? "file")} ${detail}]`;
}
