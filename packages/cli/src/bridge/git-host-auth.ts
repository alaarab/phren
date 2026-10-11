import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomic, bridgeRoot } from "./protocol.js";

const exec = promisify(execFile);

/** Tokens for the git hosts the Hook reads over HTTP (GitLab, gitboy). GitHub
 * goes through gh, which keeps its own sign-in.
 *
 * A token comes from, in order: the host's own environment variable, the
 * Hook's git-hosts.json (machine config like elevenlabs.json: mode 600, never
 * in the synced store), then the host's CLI where it has one (glab). The Hook
 * runs as a service that doesn't see shell env, so the file is the durable
 * source, written by `phren bridge git-host set` or the desktop's Connect. */

export type TokenHostKind = "gitlab" | "gitboy";
export type TokenSource = "environment" | "file" | "cli";

export interface HostToken { token: string; source: TokenSource; user?: string }

export function gitHostsFile(): string {
  return path.join(bridgeRoot(), "git-hosts.json");
}

interface StoredHost { kind: TokenHostKind; token: string; user?: string; savedAt?: string }
type StoredFile = { hosts: Record<string, StoredHost> };

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

/** The stored tokens. A file other users can read is ignored, as apns.json is. */
async function readStore(file = gitHostsFile()): Promise<StoredFile | "unsafe" | null> {
  let info;
  try { info = await stat(file); } catch { return null; }
  if (!info.isFile()) return null;
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) return "unsafe";
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { hosts?: unknown };
    const hosts: Record<string, StoredHost> = {};
    if (parsed.hosts && typeof parsed.hosts === "object") {
      for (const [domain, raw] of Object.entries(parsed.hosts as Record<string, unknown>)) {
        const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const token = clean(entry.token);
        const kind = entry.kind === "gitlab" || entry.kind === "gitboy" ? entry.kind : null;
        if (token && kind) hosts[normalDomain(domain)] = { kind, token, ...(clean(entry.user) ? { user: clean(entry.user) } : {}), ...(clean(entry.savedAt) ? { savedAt: clean(entry.savedAt) } : {}) };
      }
    }
    return { hosts };
  } catch { return null; }
}

/** Store (or, with an empty token, forget) one domain's token. */
export async function writeHostToken(domain: string, kind: TokenHostKind, token: string, user?: string, file = gitHostsFile()): Promise<void> {
  const key = normalDomain(domain);
  if (!key || /[\s/]/.test(key)) throw new Error("That is not a host name.");
  const current = await readStore(file);
  const hosts = current && current !== "unsafe" ? { ...current.hosts } : {};
  const value = clean(token);
  if (value) hosts[key] = { kind, token: value, ...(user ? { user } : {}), savedAt: new Date().toISOString() };
  else delete hosts[key];
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomic(file, JSON.stringify({ hosts }, null, 2) + "\n", 0o600);
}

/** The environment variables each host's own tools read. GITLAB_TOKEN is
 * glab's; it applies to gitlab.com, or to the domain GITLAB_HOST names. */
function fromEnv(kind: TokenHostKind, domain: string, env: NodeJS.ProcessEnv): string | undefined {
  if (kind === "gitlab") {
    const named = clean(env.GITLAB_HOST)?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (domain === "gitlab.com" ? !named || named === "gitlab.com" : named === domain) return clean(env.GITLAB_TOKEN) ?? clean(env.GL_TOKEN);
    return undefined;
  }
  const named = clean(env.GITBOY_HOST)?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return !named || named === domain ? clean(env.GITBOY_TOKEN) : undefined;
}

/** glab's stored token for a domain, when glab is installed and signed in. */
async function fromCli(kind: TokenHostKind, domain: string): Promise<string | undefined> {
  if (kind !== "gitlab") return undefined;
  try {
    const { stdout } = await exec("glab", ["config", "get", "token", "--host", domain], { timeout: 5_000, env: { ...process.env, NO_COLOR: "1", GLAB_NO_PROMPT: "1" } });
    return clean(stdout);
  } catch { return undefined; }
}

export interface TokenLookup { env?: NodeJS.ProcessEnv; file?: string; cli?: boolean }

export async function resolveHostToken(kind: TokenHostKind, domain: string, options: TokenLookup = {}): Promise<HostToken | undefined> {
  const key = normalDomain(domain);
  const env = fromEnv(kind, key, options.env ?? process.env);
  if (env) return { token: env, source: "environment" };
  const store = await readStore(options.file);
  const stored = store && store !== "unsafe" ? store.hosts[key] : undefined;
  if (stored && stored.kind === kind) return { token: stored.token, source: "file", ...(stored.user ? { user: stored.user } : {}) };
  if (options.cli !== false) {
    const cli = await fromCli(kind, key);
    if (cli) return { token: cli, source: "cli" };
  }
  return undefined;
}

/** Each stored domain with its kind and who it signs in as. Never a token. */
export async function listHostTokens(file = gitHostsFile()): Promise<{ domain: string; kind: TokenHostKind; user?: string; savedAt?: string }[] | "unsafe"> {
  const store = await readStore(file);
  if (store === "unsafe") return "unsafe";
  return Object.entries(store?.hosts ?? {}).map(([domain, { kind, user, savedAt }]) => ({ domain, kind, ...(user ? { user } : {}), ...(savedAt ? { savedAt } : {}) }));
}
