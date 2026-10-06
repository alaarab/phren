import { type PhrenResult } from "../shared.js";
import type { TaskItem } from "../data/tasks.js";
interface GithubIssueRef {
    repo?: string;
    issueNumber?: number;
    url?: string;
}
export declare function parseGithubIssueUrl(url: string): GithubIssueRef | null;
/** @internal Exported for tests. */
export declare function extractGithubRepoFromText(content: string): string | undefined;
export declare function resolveProjectGithubRepo(phrenPath: string, project: string): string | undefined;
export declare function buildTaskIssueBody(project: string, item: TaskItem): string;
export declare function createGithubIssueForTask(args: {
    repo: string;
    title: string;
    body: string;
}): PhrenResult<{
    repo: string;
    issueNumber?: number;
    url: string;
}>;
export {};
