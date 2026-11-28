import { homedir } from "node:os";
import { parseForgeUrl, type ForgeItem } from "../forge/links.js";
import { hostInfo, kindFromDomain, providerFor } from "./git-hosts.js";

const FORGE_TTL_MS = 60_000;
/** `at` is the last completed attempt, `startedAt` the latest start, `readAt` the last success. */
interface Cached { at: number; startedAt: number; readAt?: number; value?: ForgeItem; error?: string; pending?: Promise<void> }
const forgeCache = new Map<string, Cached>();

/** At most this many forge reads (`gh` processes, gitboy calls) at once,
 * whatever the Inbox asks for; the rest queue and fill the cache. */
const FORGE_CONCURRENCY = 4;
let forgeRunning = 0;
const forgeQueue: (() => void)[] = [];
async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (forgeRunning >= FORGE_CONCURRENCY) await new Promise<void>(resolve => forgeQueue.push(resolve));
  forgeRunning++;
  try { return await run(); } finally { forgeRunning--; forgeQueue.shift()?.(); }
}

async function fetchForge(url: string): Promise<ForgeItem> {
  const parsed = parseForgeUrl(url);
  if (!parsed) throw new Error("Unrecognised forge link.");
  const host = hostInfo(kindFromDomain(parsed.domain) ?? "github", { domain: parsed.domain, webUrl: `https://${parsed.domain}/${parsed.repo}`, remote: null, source: "url" });
  const provider = providerFor(host);
  if (!provider?.item) throw new Error(`Phren cannot read ${provider?.name ?? parsed.domain} pull requests yet.`);
  return limited(() => provider.item!(homedir(), "pull", parsed.number, host));
}

/** Refresh after a minute or when the inbox needs a newer reversible reading. Wait at most `waitMs`. */
async function forgeState(url: string, after: number): Promise<Cached | undefined> {
  const key = url, now = Date.now();
  let entry = forgeCache.get(key);
  if (!entry || (!entry.pending && (now - entry.at >= FORGE_TTL_MS || (entry.startedAt <= after && entry.value?.state !== "merged")))) {
    const next: Cached = { ...entry, at: entry?.at ?? 0, startedAt: now };
    next.pending = fetchForge(url).then(value => { next.value = value; next.error = undefined; next.readAt = Date.now(); },
      error => { next.error = (error instanceof Error ? error.message : String(error)).slice(0, 300); })
      .finally(() => { next.at = Date.now(); next.pending = undefined; });
    forgeCache.set(key, next);
    if (forgeCache.size > 2000) forgeCache.delete(forgeCache.keys().next().value!);
    entry = next;
  }
  return entry.at ? entry : undefined;
}

/** Nonblocking inbox probe. A reversible closure needs a successful read started after the item changed. */
export async function cachedPull(url: string, after: number): Promise<ForgeItem | undefined> {
  const parsed = parseForgeUrl(url);
  if (!parsed || parsed.kind !== "pull") return undefined;
  const entry = await forgeState(parsed.url, after);
  if (entry?.value?.state === "closed" && (entry.startedAt <= after || entry.pending || entry.error !== undefined)) return undefined;
  return entry?.value;
}
