/**
 * Canonical store filenames. A dependency-free leaf so path helpers and the
 * profile store do not pull the whole findings/task data layer just for a
 * string.
 */
export const FINDINGS_FILENAME = "FINDINGS.md";
export const TASKS_FILENAME = "tasks.md";
export const TASK_FILE_ALIASES = [TASKS_FILENAME] as const;

export function isTaskFileName(filename: string): boolean {
  return filename.toLowerCase() === TASKS_FILENAME;
}