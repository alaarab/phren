/**
 * This computer's checkouts, for citations that name their repo portably.
 * A new citation records `remote` (`github.com/owner/repo`, from
 * `git remote get-url origin`) instead of an absolute path, so any computer
 * with a clone of that remote can check it. A project's checkout is found the
 * way the code index finds it: the store's registered source folder for this
 * computer, then a folder named after the project under the usual roots.
 */
import * as fs from "fs";
import * as path from "path";
import { parseRemoteUrl } from "../bridge/git-hosts.js";
import { homeDir } from "../home-paths.js";
import { EXEC_TIMEOUT_QUICK_MS } from "../phren-core.js";
import { debugLog } from "../phren-paths.js";
import { getProjectRemote, getProjectSourcePath } from "../project-config.js";
import { getStoreProjectDirs, resolveAllStores } from "../store-registry.js";
import { errorMessage, runGitOrThrow } from "../utils.js";

// The roots the code index and locateProject search for a project's folder.
const SEARCH_ROOTS = ["", "Sites", "Projects", "projects", "Code", "code", "dev", "src", "repos", "workspace"];
// Long-lived processes (the MCP server, the Hook) see clones and remote changes after this.
const CACHE_MS = 5 * 60_000;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

let gitCalls = 0;
const originCache = new Map<string, { at: number; remote: string | undefined }>();
const remoteCache = new Map<string, { at: number; dir: string | undefined }>();
const foldersCache = new Map<string, { at: number; folders: string[] }>();

/** Git processes started here; citation checks count them against their per-run cap. */
export function checkoutGitCallCount(): number {
  return gitCalls;
}

/**
 * A remote URL as `host/owner/repo`: `git@github.com:owner/repo.git`,
 * `ssh://git@GitHub.com:22/owner/repo` and `https://user:token@github.com/owner/repo`
 * all give `github.com/owner/repo`. User names, passwords, ports, query strings and
 * `.git` are dropped, and the host is lower-cased; the path keeps its case, and
 * remotes are compared without it. A local path or anything else that is not a clone
 * URL is undefined.
 */
export function citationRemote(url: string): string | undefined {
  const parsed = parseRemoteUrl(url);
  return parsed ? identity(parsed.domain, parsed.path) : undefined;
}

/** A citation's stored `remote` in the form `citationRemote` writes, or undefined when it is not one. */
function storedRemote(value: string): string | undefined {
  const [host, ...rest] = value.trim().replace(/\/+$/, "").split("/");
  return rest.length ? identity(host, rest.join("/").replace(/\.git$/i, "")) : undefined;
}

function identity(domain: string, repoPath: string): string | undefined {
  const host = domain.toLowerCase().replace(/\.$/, "");
  const segments = repoPath.split("/");
  if (host.length < 2 || !HOST.test(host)) return undefined;
  if (!segments.every(part => SEGMENT.test(part) && part !== "." && part !== "..")) return undefined;
  return [host, ...segments].join("/");
}

/** A checkout's `origin` remote as `citationRemote` gives it, from `git remote get-url origin`; undefined when it has none. */
export function originRemote(dir: string): string | undefined {
  const cached = originCache.get(dir);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.remote;
  let remote: string | undefined;
  gitCalls++;
  try {
    remote = citationRemote(runGitOrThrow(dir, ["remote", "get-url", "origin"], EXEC_TIMEOUT_QUICK_MS).trim());
  } catch (err: unknown) {
    debugLog(`originRemote: no origin remote in ${dir}: ${errorMessage(err)}`);
  }
  originCache.set(dir, { at: Date.now(), remote });
  return remote;
}

// The checkout's git directory and the main repo's; they differ for a worktree, whose `.git` is a `gitdir:` file.
function gitDirs(dir: string): { gitdir: string; common: string } | undefined {
  const dotGit = path.join(dir, ".git");
  if (fs.statSync(dotGit).isDirectory()) return { gitdir: dotGit, common: dotGit };
  const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
  if (!pointer) return undefined;
  const gitdir = path.resolve(dir, pointer);
  const commondir = path.join(gitdir, "commondir");
  return { gitdir, common: fs.existsSync(commondir) ? path.resolve(gitdir, fs.readFileSync(commondir, "utf8").trim()) : gitdir };
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The commit a checkout has out, read from its git files without starting git; undefined when only git could say. */
export function checkedOutCommit(dir: string): string | undefined {
  try {
    const dirs = gitDirs(dir);
    if (!dirs) return undefined;
    const head = fs.readFileSync(path.join(dirs.gitdir, "HEAD"), "utf8").trim();
    if (SHA.test(head)) return head;
    const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
    if (!ref || ref.split("/").includes("..")) return undefined;
    for (const base of new Set([dirs.gitdir, dirs.common])) {
      try {
        const sha = fs.readFileSync(path.join(base, ref), "utf8").trim();
        if (SHA.test(sha)) return sha;
      } catch { /* packed */ }
    }
    for (const line of fs.readFileSync(path.join(dirs.common, "packed-refs"), "utf8").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && SHA.test(sha)) return sha;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

let rewrites: { at: number; files: string; found: boolean } | undefined;
// `url.<base>.insteadOf` in the user's git config changes what `git remote get-url` prints.
function globalRewrites(env: NodeJS.ProcessEnv): boolean {
  const xdg = env.XDG_CONFIG_HOME || path.join(homeDir(env), ".config");
  const files = [path.join(homeDir(env), ".gitconfig"), path.join(xdg, "git", "config")];
  if (rewrites && rewrites.files === files.join("\0") && Date.now() - rewrites.at < CACHE_MS) return rewrites.found;
  const found = files.some(file => {
    try { return /^\s*\[\s*(?:url|include|includeIf)\b/im.test(fs.readFileSync(file, "utf8")); } catch { return false; }
  });
  rewrites = { at: Date.now(), files: files.join("\0"), found };
  return found;
}

/**
 * `origin`'s URL read straight from the repo's config, so matching a remote against every checkout
 * starts no git process: null when the config has no origin, undefined when only git can say
 * (an include, a URL rewrite here or in the user's config, a URL it cannot parse), and the caller then asks git.
 */
function configuredOrigin(dir: string, env: NodeJS.ProcessEnv): string | null | undefined {
  if (globalRewrites(env)) return undefined;
  try {
    const dirs = gitDirs(dir);
    if (!dirs) return undefined;
    const config = fs.readFileSync(path.join(dirs.common, "config"), "utf8");
    if (/^\s*\[\s*(?:include|includeIf|url)\b/im.test(config)) return undefined;
    let inOrigin = false;
    for (const line of config.split("\n")) {
      const section = /^\s*\[([^\]]*)\]/.exec(line);
      if (section) { inOrigin = /^\s*remote\s+"origin"\s*$/i.test(section[1]); continue; }
      const url = inOrigin ? /^\s*url\s*=\s*(.*?)\s*$/i.exec(line) : null;
      if (url) return citationRemote(url[1].replace(/^"(.*)"$/, "$1"));
    }
    return null;
  } catch {
    return undefined;
  }
}

function isRepoRoot(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, ".git")); } catch { return false; }
}

function namedFolders(name: string, env: NodeJS.ProcessEnv): string[] {
  const home = homeDir(env);
  const roots = [...(env.PROJECTS_DIR ? [env.PROJECTS_DIR] : []), ...SEARCH_ROOTS.map(root => path.join(home, root))];
  return roots.map(root => path.resolve(root, name));
}

// The repository a folder is in: the folder itself or the nearest parent with `.git`, never the home folder or above it.
function enclosingRepo(dir: string, env: NodeJS.ProcessEnv): string | undefined {
  const home = path.resolve(homeDir(env));
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (current === home || home.startsWith(current + path.sep) || current === path.dirname(current)) return undefined;
    if (isRepoRoot(current)) return current;
  }
}

// A registered folder counts through the repository it is in, so a monorepo package registered as a project finds the monorepo.
function projectFolders(storePath: string, project: string, env: NodeJS.ProcessEnv): string[] {
  let registered: string | undefined;
  try { registered = getProjectSourcePath(storePath, project); } catch { /* unreadable config: the named folders still count */ }
  const repo = registered ? enclosingRepo(registered, env) : undefined;
  return [...(repo ? [repo] : []), ...namedFolders(project, env)];
}

// A checkout's `origin`, from its git config when that is enough, else from git.
function checkoutRemote(dir: string, env: NodeJS.ProcessEnv): string | undefined {
  const configured = configuredOrigin(dir, env);
  return configured === undefined ? originRemote(dir) : configured ?? undefined;
}

/**
 * This computer's checkout of a project: the first of its candidate folders that is a git repository.
 * When the project's config names its `remote:`, only a checkout of that remote counts, so a folder
 * that merely has the project's name never puts another repo in its citations.
 */
export function projectCheckout(storePath: string, project: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let configured: string | null = null;
  try { configured = getProjectRemote(storePath, project); } catch { /* unreadable config */ }
  const wanted = configured ? citationRemote(configured)?.toLowerCase() : undefined;
  return projectFolders(storePath, project, env)
    .find(dir => isRepoRoot(dir) && (!wanted || checkoutRemote(dir, env)?.toLowerCase() === wanted));
}

// Every store project's candidate folders, in project order; listed once per cache period for a run of checks.
function storeProjectFolders(phrenPath: string, env: NodeJS.ProcessEnv): string[] {
  const cached = foldersCache.get(phrenPath);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.folders;
  let folders: string[] = [];
  try {
    folders = resolveAllStores(phrenPath, { migrateAttachments: false })
      .filter(store => store.available !== false)
      .flatMap(store => {
        const storePath = store.role === "primary" ? phrenPath : store.path;
        return getStoreProjectDirs({ ...store, path: storePath }).sort().flatMap(dir => projectFolders(storePath, path.basename(dir), env));
      });
  } catch (err: unknown) {
    debugLog(`citation checkouts: could not list store projects: ${errorMessage(err)}`);
  }
  foldersCache.set(phrenPath, { at: Date.now(), folders });
  return folders;
}

/**
 * This computer's checkout of a remote: a folder named after the repo first,
 * then every store project's checkout. Only a folder whose `origin` is the same
 * remote counts, so a folder that merely shares the name is never used.
 */
export function checkoutForRemote(phrenPath: string, remote: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = `${phrenPath}\0${remote}`;
  const cached = remoteCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.dir;
  const stored = storedRemote(remote);
  if (!stored) return undefined;
  const wanted = stored.toLowerCase();
  const name = stored.split("/").pop() ?? "";
  const matches = (candidate: string) => isRepoRoot(candidate) && checkoutRemote(candidate, env)?.toLowerCase() === wanted;
  // The store's projects are listed only when no folder named after the repo is a clone of it.
  const dir = namedFolders(name, env).find(matches)
    ?? storeProjectFolders(phrenPath, env).find(matches);
  remoteCache.set(key, { at: Date.now(), dir });
  return dir;
}

/**
 * Checkouts here that may hold a repo cited by another computer's absolute path:
 * git repositories with the same folder name, among the named folders and the
 * store projects' checkouts. The caller proves one is the same repo by finding
 * the cited commit in it.
 */
export function checkoutsNamedLike(phrenPath: string, repoPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const name = repoPath.split(/[\\/]/).filter(Boolean).pop();
  if (!name || name === "." || name === "..") return [];
  const own = path.resolve(repoPath);
  const candidates = new Set([
    ...namedFolders(name, env),
    ...storeProjectFolders(phrenPath, env).filter(dir => path.basename(dir) === name),
  ]);
  return [...candidates].filter(dir => dir !== own && isRepoRoot(dir));
}
