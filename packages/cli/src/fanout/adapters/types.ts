import type { ChildProcess } from "node:child_process";
import type { DriveOptions } from "../opencode-serve.js";
export type Provider = "codex" | "opencode" | "claude";
export interface LaunchOptions {
  model: string;
  worktree: string;
  job: string;
  review?: boolean;
  resume?: string;
  variant?: string;
  extra?: string[];
}
export interface Adapter {
  command: Provider;
  argv(options: LaunchOptions): string[];
  session(event: Record<string, unknown>): string | undefined;
  /** A harness that serves an API instead of printing events: the launcher
   * spawns `argv` and this drives the worker, returning its exit code. */
  drive?(child: ChildProcess, options: DriveOptions): Promise<number>;
}
export function uuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
}
