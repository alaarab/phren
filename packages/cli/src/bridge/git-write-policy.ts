import type { IncomingHttpHeaders } from "node:http";

// Require this no earlier than the first Hook release on or after 2026-11-15,
// once the warning counts show no older clients (owner-approved 2026-10-14).
export const EXPECTED_REPOSITORY_REQUIRED = false;

const WRITE_ROUTES = new Set(["stage", "unstage", "discard", "commit", "push", "pr", "pr/merge", "host-token", "checkout", "fetch", "pull", "apply"]
  .map(action => `/v1/git/${action}`));

export const isGitWriteRoute = (route: string): boolean => WRITE_ROUTES.has(route);

/** Request metadata is a diagnostic hint, never an authentication identity.
 * The raw SSH byte pipe does not expose the paired key's label to the Hook. */
function clientIdentity(headers: IncomingHttpHeaders): string {
  const clean = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(", ") : value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
  const client = clean(headers["x-phren-client"]);
  const version = clean(headers["x-phren-app-version"] || headers["x-phren-client-version"]);
  const agent = clean(headers["user-agent"]);
  return [client, version, agent].filter(Boolean).join(" / ") || "unknown client";
}

/** Per Hook run, bounded client counts and one warning per client and route. */
export class GitWriteDiagnostics {
  private readonly clients = new Map<string, { count: number; routes: Set<string> }>();

  record(route: string, headers: IncomingHttpHeaders): void {
    let client = clientIdentity(headers);
    if (!this.clients.has(client) && this.clients.size >= 128) client = "other clients";
    let entry = this.clients.get(client);
    if (!entry) { entry = { count: 0, routes: new Set() }; this.clients.set(client, entry); }
    entry.count++;
    if (!entry.routes.has(route)) {
      entry.routes.add(route);
      console.warn(`[phren-hook] ${route}: git write without expectedRepository from ${client}; update the app before the compatibility window ends.`);
    }
  }

  snapshot(): { client: string; count: number; warning: string }[] {
    return [...this.clients].map(([client, entry]) => ({ client, count: entry.count,
      warning: `${entry.count} git writes without expectedRepository from ${client}` }));
  }
}
