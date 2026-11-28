import { lstat, readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ForgeError, providerFor, type IssueRef } from "../forge/issues.js";
import { repoParts } from "../forge/repositories.js";
import { tryFileLock } from "../governance/locks.js";
import { parseForgeUrl } from "../task/work.js";
import { atomic, atomicInPrivateDir, BridgeError, bridgeRoot } from "./protocol.js";

const dispatchId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const repoSchema = z.string().max(300).transform((value, ctx) => {
  try { return repoParts(value).repo; }
  catch {
    ctx.addIssue({ code: "custom", message: "Use a GitHub or gitboy repository." });
    return z.NEVER;
  }
});
const numberSchema = z.number().int().positive();
const issueRefSchema = z.object({ repo: repoSchema, number: numberSchema }).strict();
export const dispatchIssueSchema = z.union([
  issueRefSchema,
  z.string().max(320).regex(/^[^#]+#[1-9]\d*$/).transform(value => {
    const [repo, number] = value.split("#");
    return { repo, number: Number(number) };
  }).pipe(issueRefSchema),
]).describe("Forge issue as domain/owner/name#N or {repo, number}.");

export function issueReference(issue: IssueRef): string { return `${issue.repo}#${issue.number}`; }
export function issueBriefBlock(issue: IssueRef): string {
  const ref = issueReference(issue);
  const { kind, path: repo } = repoParts(issue.repo);
  const closing = kind === "github" ? `PRs say Closes ${repo}#${issue.number}.`
    : `PRs against ${issue.repo} say Closes #${issue.number}.`;
  return `Issue: ${ref} (https://${issue.repo}/issues/${issue.number})\nPost ONE summary comment on ${ref} when you finish (comment_issue or phren issue comment).\n${closing}`;
}

function sidecar(id: string): string {
  // A separate directory keeps old receipt readers and history limits off the sidecars.
  return path.join(bridgeRoot(), "dispatch-issues", `${dispatchId.parse(id)}.json`);
}

export async function writeDispatchIssue(id: string, issue: IssueRef): Promise<void> {
  const file = sidecar(id);
  const current = await readDispatchIssue(id);
  if (!current) await atomicInPrivateDir(file, issue);
  else if (issueReference(current).toLowerCase() !== issueReference(issue).toLowerCase())
    throw new BridgeError(409, "This dispatch id is already bound to another issue.");
}

const inFlight = new Map<string, Promise<void>>();

/** The reporting Hook keeps one ledger entry per issue and PR. Only the URL
 * leaves the Hook. Report notes and test output remain in the normal return. */
export async function linkIssuePulls(issue: IssueRef, reports: readonly { url: string }[]): Promise<void> {
  const pulls = reports.map(report => {
    const parsed = parseForgeUrl(report.url);
    return parsed?.kind === "pull" ? parsed.url : undefined;
  });
  const urls = [...new Set(pulls.filter(url => url !== undefined))];
  if (!urls.length) throw new BridgeError(400, "The report has no recognized pull request URL.");
  const failures: PromiseRejectedResult[] = [];
  for (let start = 0; start < urls.length; start += 4) {
    const batch = await Promise.allSettled(urls.slice(start, start + 4).map(url => queuePullLink(issue, url)));
    failures.push(...batch.filter(row => row.status === "rejected"));
  }
  if (failures.length) throw failures[0].reason;
  if (pulls.includes(undefined))
    throw new BridgeError(400, "The report includes an unrecognized pull request URL.");
}

function queuePullLink(issue: IssueRef, url: string): Promise<void> {
  const identity = JSON.stringify([issueReference(issue).toLowerCase(), url.toLowerCase()]);
  const hash = createHash("sha256").update(identity).digest("hex");
  const file = path.join(bridgeRoot(), "issue-pr-links", `${hash}.json`);
  let pending = inFlight.get(file);
  if (!pending) {
    pending = postPullLink(file, issue, url).finally(() => inFlight.delete(file));
    inFlight.set(file, pending);
  }
  return pending;
}

async function postPullLink(file: string, issue: IssueRef, url: string): Promise<void> {
  const release = tryFileLock(file);
  if (!release) throw new BridgeError(409, "The PR link is being posted. Retry the report.");
  try {
    const previous = await readFile(file, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (previous === '"posted"') return;
    if (previous !== undefined) throw new BridgeError(409, `The forge may already have received PR ${url}. Check the issue before posting the link again.`);
    // Record the attempt before the remote write. Only a definite refusal
    // reopens it for retry. A lost reply or a restart can leave it pending.
    await atomic(file, JSON.stringify("pending"));
    try {
      await providerFor(issue.repo).comment(issue, `PR ${url}`);
    } catch (error) {
      if (error instanceof ForgeError && error.code !== "unavailable") {
        await unlink(file);
        throw error;
      }
      throw new BridgeError(502, `The forge did not confirm PR ${url}. Check the issue before posting the link again.`);
    }
    await atomic(file, JSON.stringify("posted"));
  } finally {
    release();
  }
}

export async function readDispatchIssue(id: string): Promise<IssueRef | undefined> {
  const file = sidecar(id);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024) throw new Error("Invalid dispatch issue sidecar.");
    return issueRefSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
