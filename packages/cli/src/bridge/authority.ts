import { tryFileLock } from "../governance/locks.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import { z } from "zod";
import { atomic, BridgeError, bridgeRoot, PERMISSION_MODES, type PermissionMode } from "./protocol.js";

/**
 * The owner's release authority policy: per project, which release-type
 * actions a conductor may send a worker to do on its own (`go`) and which need
 * the owner's word each time (`ask`). It only restricts: nothing here lifts a
 * worker's own permission checks. See docs/authority.md.
 */
export const RELEASE_ACTIONS = ["merge", "publish", "deploy", "app-store", "github-admin"] as const;
export type ReleaseAction = typeof RELEASE_ACTIONS[number];
export const releaseAction = z.enum(RELEASE_ACTIONS);
const verdict = z.enum(["go", "ask"]);
type Verdict = z.infer<typeof verdict>;
const projectSlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const writer = z.enum(["phone", "cli"]);
export type AuthorityWriter = z.infer<typeof writer>;

export const projectEntrySchema = z.object({
  default: verdict.optional().describe("go or ask for the release actions `actions` does not list; go when omitted."),
  actions: z.object({
    merge: verdict.optional(), publish: verdict.optional(), deploy: verdict.optional(),
    "app-store": verdict.optional(), "github-admin": verdict.optional(),
  }).strict().optional(),
  maxPermissionMode: z.enum(PERMISSION_MODES).optional()
    .describe("Highest permission mode an agent may start a worker in here; auto-edits when omitted and any action is ask."),
  note: z.string().min(1).max(300).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
}).strict();
export type ProjectEntry = z.infer<typeof projectEntrySchema>;

const fileSchema = z.object({
  projects: z.record(projectSlug, projectEntrySchema).refine(value => Object.keys(value).length <= 256, "At most 256 projects."),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  updatedBy: writer.optional(),
}).strict();
export type AuthorityFile = z.infer<typeof fileSchema>;

/** Used until the owner first writes the policy: hub and safety are ask-first,
 * and Mina is go for App Store work (the owner's word, 2026-09-29). */
export const DEFAULT_AUTHORITY: AuthorityFile = { projects: {
  hub: { default: "ask" },
  safety: { default: "ask" },
  mina: { actions: { "app-store": "go" }, note: "Owner authorized App Store work on 2026-09-29." },
} };

/** The permission ceiling of a project with any ask-first action that names none. */
export const ASK_FIRST_PERMISSION_MODE: PermissionMode = "auto-edits";

const authorityFile = (root = bridgeRoot()) => path.join(root, "authority.yaml");
const confirmationsFile = (root = bridgeRoot()) => path.join(root, "authority-confirmations.json");

async function privateFile(file: string, name: string): Promise<boolean> {
  const info = await lstat(file).catch(() => undefined);
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || (info.mode & 0o077)) {
    throw new BridgeError(409, `${name} must be a private regular file (0600), at most 64 KiB.`);
  }
  return true;
}

/** js-yaml reads an unquoted timestamp as a Date; the schema takes strings. */
function normalize(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const file = { ...(raw as Record<string, unknown>) };
  if (file.updatedAt instanceof Date) file.updatedAt = file.updatedAt.toISOString();
  return file;
}

export interface AuthorityPolicy extends AuthorityFile { source: "file" | "defaults" }

/** The saved policy, or the built-in defaults when the owner has written none.
 * A file that is not private or does not parse is an error, never "no policy". */
export async function readAuthority(root = bridgeRoot()): Promise<AuthorityPolicy> {
  const file = authorityFile(root);
  if (!await privateFile(file, "authority.yaml")) return { ...structuredClone(DEFAULT_AUTHORITY), source: "defaults" };
  const parsed = fileSchema.safeParse(normalize(load(await readFile(file, "utf8")) ?? { projects: {} }));
  if (!parsed.success) throw new BridgeError(409, "authority.yaml does not match the release authority schema. Fix it with `phren authority set` or remove the broken entry.");
  return { ...parsed.data, source: "file" };
}

export interface ProjectAuthority {
  project: string;
  /** The policy names this project; an unlisted one is go for everything. */
  listed: boolean;
  go: ReleaseAction[];
  ask: ReleaseAction[];
  maxPermissionMode?: PermissionMode;
  note?: string;
  /** One sentence a conductor quotes in a brief. */
  line: string;
}

export function projectAuthority(policy: Pick<AuthorityFile, "projects">, project: string): ProjectAuthority {
  const entry = Object.hasOwn(policy.projects, project) ? policy.projects[project] : undefined;
  const verdictOf = (action: ReleaseAction): Verdict => entry?.actions?.[action] ?? entry?.default ?? "go";
  const go = RELEASE_ACTIONS.filter(action => verdictOf(action) === "go");
  const ask = RELEASE_ACTIONS.filter(action => verdictOf(action) === "ask");
  const maxPermissionMode = entry?.maxPermissionMode ?? (ask.length ? ASK_FIRST_PERMISSION_MODE : undefined);
  const parts = [
    ...(!entry ? ["no release restrictions listed"] : []),
    ...(entry && go.length ? [`go for ${go.join(", ")}`] : []),
    ...(ask.length ? [`ask-first for ${ask.join(", ")}`] : []),
    ...(maxPermissionMode ? [`dispatched workers start at most in ${maxPermissionMode}`] : []),
  ];
  const line = `Release authority for ${project} (owner policy): ${parts.join("; ")}.${entry?.note ? ` Note: ${entry.note}` : ""}`;
  return { project, listed: !!entry, go, ask, ...(maxPermissionMode ? { maxPermissionMode } : {}), ...(entry?.note ? { note: entry.note } : {}), line };
}

/** The lower of two permission ceilings; undefined is no ceiling. */
export function lowerMode(a: PermissionMode | undefined, b: PermissionMode | undefined): PermissionMode | undefined {
  if (!a || !b) return a ?? b;
  return PERMISSION_MODES.indexOf(a) <= PERMISSION_MODES.indexOf(b) ? a : b;
}

const mutations = new Map<string, Promise<unknown>>();
/** One change at a time in this process, and a file lock across processes. */
async function mutate<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = mutations.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
    const release = tryFileLock(key);
    if (!release) throw new BridgeError(409, "The release authority policy is being updated. Try again.");
    try { return await action(); } finally { release(); }
  });
  mutations.set(key, pending);
  try { return await pending; } finally { if (mutations.get(key) === pending) mutations.delete(key); }
}

async function writeAuthority(root: string, projects: AuthorityFile["projects"], by: AuthorityWriter): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(projects).sort(([a], [b]) => a.localeCompare(b)));
  const file: AuthorityFile = fileSchema.parse({ projects: sorted, updatedAt: new Date().toISOString(), updatedBy: by });
  await atomic(authorityFile(root), dump(file, { lineWidth: 120 }));
}

export const setAuthoritySchema = projectEntrySchema.extend({ project: projectSlug }).strict();

/** Replace one project's entry. The first write saves the defaults with it. */
export async function setProjectAuthority(input: unknown, by: AuthorityWriter, root = bridgeRoot()): Promise<ProjectAuthority> {
  const { project, ...entry } = setAuthoritySchema.parse(input);
  return mutate(authorityFile(root), async () => {
    const { projects } = await readAuthority(root);
    const next = { ...projects, [project]: entry };
    await writeAuthority(root, next, by);
    return projectAuthority({ projects: next }, project);
  });
}

/** Drop one project's entry, which makes it go for everything. */
export async function clearProjectAuthority(input: unknown, by: AuthorityWriter, root = bridgeRoot()): Promise<ProjectAuthority> {
  const { project } = z.object({ project: projectSlug }).strict().parse(input);
  return mutate(authorityFile(root), async () => {
    const { projects } = await readAuthority(root);
    if (!Object.hasOwn(projects, project)) throw new BridgeError(404, `The release authority policy does not list ${project}.`);
    const { [project]: _removed, ...rest } = projects;
    await writeAuthority(root, rest, by);
    return projectAuthority({ projects: rest }, project);
  });
}

const confirmationSchema = z.object({
  id: z.string().uuid(), project: projectSlug, actions: z.array(releaseAction).min(1).max(RELEASE_ACTIONS.length),
  confirmedAt: z.string().datetime(), expiresAt: z.string().datetime(), by: writer,
}).strict();
export type Confirmation = z.infer<typeof confirmationSchema>;
const confirmationsListSchema = z.array(confirmationSchema).max(32);
export const confirmInputSchema = z.object({
  project: projectSlug,
  actions: z.array(releaseAction).min(1).max(RELEASE_ACTIONS.length),
  minutes: z.number().int().min(1).max(24 * 60).optional().describe("How long the confirmation waits to be used; 30 when omitted."),
}).strict();
export const DEFAULT_CONFIRMATION_MINUTES = 30;

async function readConfirmations(root: string, now: number): Promise<Confirmation[]> {
  const file = confirmationsFile(root);
  if (!await privateFile(file, "authority-confirmations.json")) return [];
  const parsed = confirmationsListSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
  // A damaged list confirms nothing: the owner confirms again.
  if (!parsed.success) return [];
  return parsed.data.filter(item => Date.parse(item.expiresAt) > now);
}

/** Confirmations still waiting to be used. */
export async function listConfirmations(root = bridgeRoot()): Promise<Confirmation[]> {
  return readConfirmations(root, Date.now());
}

/** The owner's word for one agent dispatch of these release actions to this project. */
export async function confirmAuthority(input: unknown, by: AuthorityWriter, root = bridgeRoot()): Promise<Confirmation> {
  const data = confirmInputSchema.parse(input);
  return mutate(confirmationsFile(root), async () => {
    const now = Date.now();
    const existing = await readConfirmations(root, now);
    if (existing.length >= 32) throw new BridgeError(409, "32 release confirmations are already waiting. Let some expire first.");
    const confirmation: Confirmation = { id: randomUUID(), project: data.project, actions: [...new Set(data.actions)],
      confirmedAt: new Date(now).toISOString(), expiresAt: new Date(now + (data.minutes ?? DEFAULT_CONFIRMATION_MINUTES) * 60_000).toISOString(), by };
    await atomic(confirmationsFile(root), [...existing, confirmation]);
    return confirmation;
  });
}

/** Use up the oldest confirmation that covers every one of `actions` for
 * `project`, or return undefined when none does. */
export async function consumeConfirmation(project: string, actions: readonly ReleaseAction[], root = bridgeRoot()): Promise<Confirmation | undefined> {
  return mutate(confirmationsFile(root), async () => {
    const now = Date.now();
    const existing = await readConfirmations(root, now);
    const index = existing.findIndex(item => item.project === project && actions.every(action => item.actions.includes(action)));
    if (index < 0) return undefined;
    const [used] = existing.splice(index, 1);
    await atomic(confirmationsFile(root), existing);
    return used;
  });
}

export interface AuthorityCheck {
  /** The permission mode the worker should start in, when the policy sets one the call did not. */
  permissionMode?: PermissionMode;
  authority: ProjectAuthority;
  confirmation?: Confirmation;
}

/**
 * What the policy asks of an agent's dispatch: refuse a mode above the
 * project's ceiling (lowered further by `grantCeiling`), start one that named
 * no mode at that ceiling, and refuse an ask-first release action the owner
 * has not confirmed. Only an agent's call is checked; the owner's never is.
 * The confirmation is used up only when everything else passed.
 */
export async function checkAgentDispatch(data: { project: string; harness: string; permissionMode?: PermissionMode; releaseActions?: readonly ReleaseAction[] },
  grantCeiling: PermissionMode, root = bridgeRoot()): Promise<AuthorityCheck> {
  const authority = projectAuthority(await readAuthority(root), data.project);
  const ceiling = authority.maxPermissionMode ? lowerMode(authority.maxPermissionMode, grantCeiling)! : undefined;
  let permissionMode: PermissionMode | undefined;
  if (ceiling) {
    if (data.harness === "opencode") {
      throw new BridgeError(403, `${data.project} caps dispatched workers at ${ceiling}, and OpenCode takes its permissions from its own config. Dispatch Claude or Codex, or ask the owner to dispatch it.`);
    }
    if (data.permissionMode && PERMISSION_MODES.indexOf(data.permissionMode) > PERMISSION_MODES.indexOf(ceiling)) {
      throw new BridgeError(403, `The release authority policy caps agent-dispatched workers for ${data.project} at ${ceiling}. Ask for ${ceiling} or lower, or ask the owner to dispatch it.`);
    }
    if (!data.permissionMode) permissionMode = ceiling;
  }
  const needed = [...new Set(data.releaseActions ?? [])].filter(action => authority.ask.includes(action));
  if (!needed.length) return { ...(permissionMode ? { permissionMode } : {}), authority };
  const confirmation = await consumeConfirmation(data.project, needed, root);
  if (!confirmation) {
    throw new BridgeError(403, `${data.project} is ask-first for ${needed.join(", ")}. Ask the owner; they confirm it on the phone or with \`phren authority confirm ${data.project} ${needed.join(",")}\`, or dispatch it themselves.`);
  }
  return { ...(permissionMode ? { permissionMode } : {}), authority, confirmation };
}
