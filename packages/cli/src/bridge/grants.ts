import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import { z } from "zod";
import { BridgeError, bridgeRoot, computerName } from "./protocol.js";

const grantAction = z.enum(["dispatch", "hand_off"]);
const grantScope = z.union([
  z.literal("global"),
  z.string().regex(/^project:[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
]);
export const grantSchema = z.object({
  scope: grantScope.describe("global, or project:<slug> for one project."),
  actions: z.array(grantAction).min(1).max(2).describe("Which conductor actions this grant covers."),
  computers: z.array(computerName).min(1).max(32).optional().describe("Named verified peers; omitted means any."),
  until: z.string().datetime({ offset: true }).optional().describe("Expiry timestamp; omitted means until revoked."),
}).strict();
export type Grant = z.infer<typeof grantSchema>;
export const grantFile = (root = bridgeRoot()) => path.join(root, "conductor.yaml");

const fileSchema = z.object({ grants: z.array(grantSchema).max(64) }).strict();

async function regularPrivateFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch(() => undefined);
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || (info.mode & 0o077)) {
    throw new BridgeError(409, "conductor.yaml must be a private regular file (0600), at most 64 KiB.");
  }
  return true;
}

/** js-yaml parses an unquoted timestamp as a Date; keep the schema string-only
 * and accept the bare `until: 2026-10-01T00:00Z` form from the docs. */
function normalizeGrants(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const file = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(file.grants)) {
    file.grants = file.grants.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const grant = { ...(item as Record<string, unknown>) };
      if (grant.until instanceof Date) grant.until = grant.until.toISOString();
      else if (typeof grant.until === "string") {
        const parsed = Date.parse(grant.until);
        if (!Number.isNaN(parsed)) grant.until = new Date(parsed).toISOString();
      }
      return grant;
    });
  }
  return file;
}

export async function listGrants(root = bridgeRoot()): Promise<Grant[]> {
  const file = grantFile(root);
  if (!await regularPrivateFile(file)) return [];
  const parsed = fileSchema.safeParse(normalizeGrants(load(await readFile(file, "utf8"))));
  if (!parsed.success) throw new BridgeError(409, "conductor.yaml does not match the grants schema.");
  const now = Date.now();
  return parsed.data.grants.filter(grant => !grant.until || Date.parse(grant.until) > now);
}

async function writeGrants(root: string, grants: Grant[]): Promise<void> {
  const file = grantFile(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, dump({ grants }, { lineWidth: 120 }), { mode: 0o600, flag: "wx" });
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

export interface GrantQuery { action: z.infer<typeof grantAction>; project?: string; computer?: string }

/** Project scope beats global; a named computer list beats any. */
function specificity(grant: Grant): number {
  return (grant.scope === "global" ? 0 : 2) + (grant.computers ? 1 : 0);
}

/** Most specific matching grant wins. A computers-restricted grant never
 * covers an unresolved destination: `anywhere` may pick a peer outside the
 * list, and a local hand-off never goes to one of them. */
export function matchGrant(grants: Grant[], query: GrantQuery, now = Date.now()): Grant | undefined {
  const matches = grants.filter(grant => {
    if (!grant.actions.includes(query.action)) return false;
    if (grant.until && Date.parse(grant.until) <= now) return false;
    if (grant.scope !== "global") {
      const slug = grant.scope.slice("project:".length);
      if (query.project !== slug) return false;
    }
    if (grant.computers && (!query.computer || query.computer === "anywhere" || !grant.computers.includes(query.computer))) return false;
    return true;
  });
  return matches.sort((a, b) => specificity(b) - specificity(a))[0];
}

export function grantLabel(grant: Grant): string {
  return grant.scope;
}

export async function addGrant(input: unknown, root = bridgeRoot()): Promise<Grant> {
  const grant = grantSchema.parse(input);
  const existing = await listGrants(root);
  if (existing.some(item => canonicalGrant(item) === canonicalGrant(grant))) {
    throw new BridgeError(409, "That grant is already listed.");
  }
  if (existing.length >= 64) throw new BridgeError(409, "conductor.yaml already holds 64 grants.");
  await writeGrants(root, [...existing, grant]);
  return grant;
}

function canonicalGrant(grant: Grant): string {
  return JSON.stringify([grant.scope, [...grant.actions].sort(), grant.computers ? [...grant.computers].sort() : null, grant.until ?? null]);
}

/** Write a grant from an approval card answer: already listed is success. */
export async function ensureGrant(input: unknown, root = bridgeRoot()): Promise<Grant> {
  const grant = grantSchema.parse(input);
  const existing = await listGrants(root);
  if (existing.some(item => canonicalGrant(item) === canonicalGrant(grant))) return grant;
  if (existing.length >= 64) throw new BridgeError(409, "conductor.yaml already holds 64 grants.");
  await writeGrants(root, [...existing, grant]);
  return grant;
}

export async function removeGrant(input: unknown, root = bridgeRoot()): Promise<Grant> {
  const body = z.object({
    index: z.number().int().min(0).max(63).optional(),
    scope: grantScope.optional(),
    actions: z.array(grantAction).min(1).max(2).optional(),
    computers: z.array(computerName).min(1).max(32).optional(),
    until: z.string().datetime({ offset: true }).optional(),
  }).strict().refine(value => value.index !== undefined || value.scope !== undefined,
    { message: "Provide an index or a scope to remove." }).parse(input);
  const existing = await listGrants(root);
  if (!existing.length) throw new BridgeError(404, "There are no conductor grants to remove.");
  let index = body.index;
  if (index === undefined) {
    // Scope names the row; the optional fields refine it. They never invent a
    // default actions list, which would miss a single-action grant.
    const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
    index = existing.findIndex(grant =>
      grant.scope === body.scope
      && (body.actions === undefined || sameSet(grant.actions, body.actions))
      && (body.computers === undefined || (grant.computers !== undefined && sameSet(grant.computers, body.computers)))
      && (body.until === undefined || grant.until === body.until));
    if (index < 0) throw new BridgeError(404, "No conductor grant matches that scope.");
  }
  if (index >= existing.length) throw new BridgeError(404, "No conductor grant has that index.");
  const [removed] = existing.splice(index, 1);
  await writeGrants(root, existing);
  return removed;
}
