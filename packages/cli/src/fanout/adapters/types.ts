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
}
export function uuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
}
