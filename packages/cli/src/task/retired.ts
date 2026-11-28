/**
 * Tasks are retired in 0.4.0: work lives in forge issues and the owner Inbox.
 *
 * The task tools and commands stay in the build for one release but only read.
 * Every writer returns this one code and message, and the automated writers
 * (Stop hook nag, prompt auto-capture, weekly audit, stale tasks) stay in the
 * code behind `TASKS_RETIRED`, so the later removal is a straight delete.
 */

export const TASKS_RETIRED = true; // tasks retired (0.4.0)

export const TASKS_RETIRED_CODE = "tasks-retired";

export const TASKS_RETIRED_MESSAGE =
  "Phren tasks are retired. Use forge issues (phren issue / create_issue) for work and the owner Inbox for owner actions. Run `phren migrate tasks` to move existing tasks.";

/** The payload every MCP task writer returns instead of writing. */
export function tasksRetiredPayload(): { ok: false; error: string; errorCode: string } {
  return { ok: false, error: TASKS_RETIRED_MESSAGE, errorCode: TASKS_RETIRED_CODE };
}
