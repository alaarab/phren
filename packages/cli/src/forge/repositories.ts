import { parseRemoteUrl } from "../bridge/git-hosts.js";
import { git } from "../bridge/projects.js";
import { findPhrenPath } from "../phren-paths.js";
import { getProjectSourcePath, isGitRepository, projectCheckoutCandidates, readProjectConfig } from "../project-config.js";
import { parseStoreQualified, resolveProject } from "../store-routing.js";
import { isValidProjectName } from "../utils-paths.js";
import { ForgeError } from "./errors.js";
import type { ForgeKind, RepoRef } from "./issues.js";

const NAME = /^(?!\.{1,2}$)[\w.-]+$/;
const DOMAIN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/;

export function parseRepo(text: string, defaultDomain = "github.com"): RepoRef {
  const input = text.trim();
  const remote = parseRemoteUrl(input);
  const parts = (remote?.path ?? input.replace(/\/+$/, "")).split("/");
  const domain = remote?.domain ?? (parts.length === 2 ? defaultDomain.trim().toLowerCase() : parts.shift()?.toLowerCase());
  // The repository component of a full issue URL is useful to all callers.
  if (remote && parts.length === 4 && parts[2] === "issues" && /^[1-9]\d*$/.test(parts[3])) parts.length = 2;
  const [owner, name] = parts;
  const repo = name?.replace(/\.git$/i, "");
  if (!domain || !DOMAIN.test(domain) || parts.length !== 2 || !NAME.test(owner ?? "") || !NAME.test(repo ?? "")) {
    throw new ForgeError("invalid", "Use owner/name, domain/owner/name or a repository URL.");
  }
  return `${domain}/${owner}/${repo}`;
}

function isShorthand(text: string): boolean {
  return /^[\w.-]+\/[\w.-]+\/*$/.test(text.trim());
}

/** Apply the project's forge domain to a bare owner/name. Explicit domains take precedence. */
export async function parseRepoForProject(text: string, project?: string, store?: string): Promise<RepoRef> {
  const repo = project && isShorthand(text) ? await repoForProject(project, store) : undefined;
  return parseRepo(text, repo?.split("/")[0]);
}

export function forgeKind(domain: string): ForgeKind {
  if (domain === "github.com") return "github";
  if (domain.startsWith("gitboy.")) return "gitboy";
  throw new ForgeError("invalid", "Use a github.com or gitboy repository.");
}

export function repoParts(input: RepoRef, expected?: ForgeKind) {
  const repo = parseRepo(input);
  const [domain, owner, name] = repo.split("/");
  const kind = forgeKind(domain);
  if (expected && expected !== kind) throw new ForgeError("invalid", "The repository belongs to a different forge.");
  return { repo, domain, kind, path: `${owner}/${name}` };
}

async function checkoutRepo(directory: string, remote: string): Promise<ReturnType<typeof repoParts> | undefined> {
  try {
    const url = (await git(directory, "config", "--get", `remote.${remote}.url`)).trim();
    return parseRemoteUrl(url) ? repoParts(url) : undefined;
  } catch {
    return undefined;
  }
}

export async function repoForProject(project: string, store?: string): Promise<RepoRef | undefined> {
  let root = store ?? findPhrenPath();
  if (!root) return undefined;
  const { storeName, projectName } = parseStoreQualified(project);
  if (!isValidProjectName(projectName)) return undefined;
  if (storeName) {
    try { root = resolveProject(root, project).store.path; }
    catch { return undefined; }
  }
  const config = readProjectConfig(root, projectName);
  const override = config.issues;
  if (override !== undefined && override !== null && typeof override !== "string") {
    throw new ForgeError("invalid", "The project's issues setting must be a repository reference.");
  }
  const configured = override?.trim();
  if (configured && !isShorthand(configured)) return repoParts(configured).repo;

  const directory = projectCheckoutCandidates(projectName, getProjectSourcePath(root, projectName, config)).find(isGitRepository);
  let checkout: Awaited<ReturnType<typeof checkoutRepo>>;
  if (directory) {
    checkout = await checkoutRepo(directory, "origin");
    if (checkout?.kind === "github") {
      const gitboy = await checkoutRepo(directory, "gitboy");
      if (gitboy?.kind === "gitboy") checkout = gitboy;
    }
  }
  return configured ? parseRepo(configured, checkout?.domain) : checkout?.repo;
}
