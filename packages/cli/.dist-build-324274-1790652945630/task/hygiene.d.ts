interface TaskHygieneIssue {
    id: string;
    line: string;
    reason: "anchors-missing" | "keywords-missing";
    evidence: string[];
}
interface TaskHygieneResult {
    ok: boolean;
    detail: string;
    issues: TaskHygieneIssue[];
}
export declare function inspectTaskHygiene(phrenPath: string, project: string, repoPath?: string | null): TaskHygieneResult;
export {};
