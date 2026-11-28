export interface ForgeUrl { domain: string; repo: string; kind: "pull" | "issue"; number: number; url: string }
/** A pull request or issue page on any of the three forges: GitHub
 * `/o/r/pull/N` and `/o/r/issues/N`, gitboy `/o/r/pulls/N` and `/o/r/issues/N`,
 * GitLab `/group/r/-/merge_requests/N` and `/-/issues/N`. */
export function parseForgeUrl(value: string): ForgeUrl | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
  const match = /^\/((?:[A-Za-z0-9_.-]+\/)+?[A-Za-z0-9_.-]+)(?:\/-)?\/(pull|pulls|merge_requests|issues)\/([1-9]\d{0,15})\/?$/.exec(url.pathname);
  if (!match) return undefined;
  const repo = match[1], number = Number(match[3]);
  if (!Number.isSafeInteger(number) || repo.split("/").some(part => part === "." || part === "..")) return undefined;
  return { domain: url.host.toLowerCase(), repo, kind: match[2] === "issues" ? "issue" : "pull", number, url: `https://${url.host.toLowerCase()}${url.pathname.replace(/\/$/, "")}` };
}

export type CheckState = "passing" | "failing" | "pending" | null;
/** One pull request or issue as the forge reports it now. */
export interface ForgeItem {
  state: "open" | "merged" | "closed";
  title?: string;
  draft?: boolean;
  /** Pull requests: the head commit's checks, one word. */
  checks?: CheckState;
  /** Pull requests: clean, blocked, conflicts, behind, draft or unknown. */
  mergeable?: "clean" | "blocked" | "conflicts" | "behind" | "draft" | "unknown";
  mergeDetail?: string;
  head?: string;
  mergedAt?: string;
  closedAt?: string;
}
/** GitHub's mergeStateStatus and gitboy's derived mergeState as one word. */
export function mergeableWord(mergeState: unknown, draft?: boolean): ForgeItem["mergeable"] {
  if (draft) return "draft";
  switch (String(mergeState ?? "").toUpperCase()) {
    case "CLEAN": case "HAS_HOOKS": case "UNSTABLE": return "clean";
    case "DIRTY": return "conflicts";
    case "BEHIND": return "behind";
    case "BLOCKED": return "blocked";
    case "DRAFT": return "draft";
    default: return "unknown";
  }
}
