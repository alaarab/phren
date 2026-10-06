/** Whether Codex's automatic reviewer, not the owner, decides this session's
 * approval requests. Codex runs the PermissionRequest hook before its reviewer
 * and the payload does not say which one will decide (permission_mode is
 * "default" either way), so read the settings the session itself recorded: the
 * latest turn_context or thread_settings_applied line in its rollout, which
 * follows /approvals changes mid-session. Codex routes a request to the
 * reviewer only with approvals_reviewer "auto_review" and an on-request or
 * granular approval policy; anything else, or a rollout that can't be read,
 * keeps the owner as the approver. */
export declare function codexAutoReview(transcriptPath: unknown): Promise<boolean>;
