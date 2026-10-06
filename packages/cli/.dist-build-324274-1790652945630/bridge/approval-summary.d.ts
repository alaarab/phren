export type RequestKind = "command" | "tool" | "edit" | "question" | "other";
export interface ApprovalRequest {
    tool?: string;
    input?: unknown;
    cwd?: string;
    message?: string;
    question?: boolean;
}
export declare function approvalTitle(agent: string, project?: string, computer?: string): string;
/** Sanitize the whole line before shortening it for the notification. */
export declare function redactApproval(value: string): string;
export declare function shortApproval(value: string): string;
export declare function approvalSummary(value: ApprovalRequest): {
    request: string;
    requestKind: RequestKind;
};
