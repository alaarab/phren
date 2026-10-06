/**
 * Canonical store filenames. A dependency-free leaf so path helpers and the
 * profile store do not pull the whole findings/task data layer just for a
 * string.
 */
export declare const FINDINGS_FILENAME = "FINDINGS.md";
export declare const TASKS_FILENAME = "tasks.md";
export declare const TASK_FILE_ALIASES: readonly ["tasks.md"];
export declare function isTaskFileName(filename: string): boolean;
