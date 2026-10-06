import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { tryFileLock } from "../governance/locks.js";
import { atomic, BridgeError, bridgeRoot, object } from "./protocol.js";
import { git } from "./projects.js";

const text = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const scopeSchema = z.object({
  project: text.refine(value => path.isAbsolute(value) && path.normalize(value) === value),
  harness: z.enum(["claude", "codex", "copilot", "opencode", "phren"]).optional(),
  session: text.optional(), computer: text.optional(),
}).strict();
export const approvalRuleDraftSchema = z.object({
  tool: text, command: text, match: z.enum(["exact", "prefix", "glob"]),
  effect: z.enum(["allow", "always-ask"]), scope: scopeSchema,
  projectName: z.string().min(1).max(100), until: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ApprovalRuleDraft = z.infer<typeof approvalRuleDraftSchema>;
export interface ApprovalRule extends ApprovalRuleDraft { id: string; createdAt: string; owner: string }
const operationSchema = z.discriminatedUnion("operation", [
  z.object({ domain: z.literal("phren-approval-rules-v1"), operation: z.literal("add"), nonce: z.string().uuid(), at: z.string().datetime({ offset: true }), rule: approvalRuleDraftSchema }).strict(),
  z.object({ domain: z.literal("phren-approval-rules-v1"), operation: z.literal("revoke"), nonce: z.string().uuid(), at: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict(),
]);
const envelopeSchema = z.object({ payload: z.string().min(1).max(16384), signature: z.string().min(1).max(128), publicKey: z.string().min(1).max(64) }).strict();
const policySchema = z.object({ operations: z.array(envelopeSchema).max(2048) }).strict();
const policyPath = (root: string) => path.join(root, "approval-rules.json");
const auditPath = (root: string) => path.join(root, "approval-rules-audit.json");
const forbidden = () => new BridgeError(403, "Confirm this change with the paired iPhone's signing key.");

/** Restricted phone keys only; dispatch keys and arbitrary SSH keys cannot sign policy. */
async function ownerKeys(): Promise<Set<string>> {
  const keys = await readFile(path.join(homeDir(), ".ssh", "authorized_keys"), "utf8");
  const result = new Set<string>();
  for (const line of keys.split("\n")) {
    const match = /^restrict,pty,command="sh ~\/\.local\/share\/phren\/bridge\/dispatch" ssh-ed25519 ([A-Za-z0-9+/]+={0,2}) phren-iphone\s*$/.exec(line);
    if (!match) continue;
    const wire = Buffer.from(match[1], "base64");
    // SSH string("ssh-ed25519"), string(32-byte key).
    if (wire.length === 51 && wire.readUInt32BE(0) === 11 && wire.subarray(4, 15).toString() === "ssh-ed25519" && wire.readUInt32BE(15) === 32) result.add(wire.subarray(19).toString("base64"));
  }
  return result;
}
function verified(envelope: z.infer<typeof envelopeSchema>, keys: Set<string>) {
  const raw = Buffer.from(envelope.publicKey, "base64"), signature = Buffer.from(envelope.signature, "base64"), payload = Buffer.from(envelope.payload, "base64");
  if (raw.length !== 32 || signature.length !== 64 || !keys.has(raw.toString("base64"))) throw forbidden();
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  if (!verify(null, payload, key, signature)) throw forbidden();
  const operation = operationSchema.parse(JSON.parse(payload.toString("utf8")));
  return { operation, owner: createHash("sha256").update(raw).digest("hex") };
}
async function privateJSON(file: string, fallback: unknown, max = 2_097_152): Promise<unknown> {
  const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return fallback;
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > max) throw new BridgeError(409, "Approval policy and audit must be private regular files.");
  return JSON.parse(await readFile(file, "utf8"));
}
async function readPolicy(root: string) {
  const policy = policySchema.parse(await privateJSON(policyPath(root), { operations: [] }));
  const keys = policy.operations.length ? await ownerKeys() : new Set<string>();
  const rules = new Map<string, ApprovalRule>(), nonces = new Set<string>();
  for (const envelope of policy.operations) {
    const { operation, owner } = verified(envelope, keys);
    if (nonces.has(operation.nonce)) throw new BridgeError(409, "Repeated policy operation.");
    nonces.add(operation.nonce);
    if (operation.operation === "add") rules.set(operation.nonce, { ...operation.rule, id: operation.nonce, createdAt: operation.at, owner });
    else rules.delete(operation.id);
  }
  return { policy, rules, nonces };
}
const queues = new Map<string, Promise<unknown>>();
async function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(root), previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(key, { recursive: true, mode: 0o700 });
    const release = tryFileLock(policyPath(key));
    if (!release) throw new BridgeError(409, "Approval rules are busy. Try again.");
    try { return await work(); } finally { release(); }
  });
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
export async function listApprovalRules(root = bridgeRoot()): Promise<ApprovalRule[]> {
  return [...(await readPolicy(root)).rules.values()];
}
/** The signed operations remain on disk and are verified again at every decision. */
export async function changeApprovalRule(input: unknown, operation: "add" | "revoke", root = bridgeRoot()) {
  const envelope = envelopeSchema.parse(input), proof = verified(envelope, await ownerKeys());
  if (proof.operation.operation !== operation || !Number.isFinite(Date.parse(proof.operation.at)) || Math.abs(Date.now() - Date.parse(proof.operation.at)) > 300_000) throw forbidden();
  return locked(root, async () => {
    const { policy, rules, nonces } = await readPolicy(root);
    if (nonces.has(proof.operation.nonce)) throw new BridgeError(409, "This change has already been applied.");
    if (operation === "add" && rules.size >= 128) throw new BridgeError(409, "Revoke a rule before adding another.");
    if (proof.operation.operation === "revoke" && !rules.has(proof.operation.id)) throw new BridgeError(409, "This rule is no longer listed.");
    if (policy.operations.length >= 2048) throw new BridgeError(409, "Approval policy history is full; owner maintenance is required.");
    policy.operations.push(envelope);
    const bytes = JSON.stringify(policy);
    if (Buffer.byteLength(bytes) > 2_097_152) throw new BridgeError(409, "Approval policy history is full; owner maintenance is required.");
    await atomic(policyPath(root), bytes);
    return { ok: true };
  });
}
export interface ApprovalRuleContext { project: string; harness: NonNullable<ApprovalRuleDraft["scope"]["harness"]>; session: string; computer: string }
/** Bind project scope to the main repository, including linked worktrees. */
export async function approvalRuleContext(cwd: string, harness: string, session: string): Promise<ApprovalRuleContext | undefined> {
  if (!path.isAbsolute(cwd)) return undefined;
  try {
    const common = await realpath((await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim());
    if (path.basename(common) !== ".git") return undefined;
    return { project: path.dirname(common), harness: scopeSchema.shape.harness.unwrap().parse(harness), session, computer: hostname() };
  } catch { return undefined; }
}
/** Deliberately a small grammar, not a shell risk detector. Unsupported syntax always asks. */
function eligible(tool: string, command: string): boolean {
  if (!["Bash", "bash", "shell", "exec_command"].includes(tool) || command.length > 4096 || !/^[A-Za-z0-9_.\/@,:=+% -]+$/.test(command)) return false;
  const words = command.split(" ");
  if (words.some(word => !word) || words.some(word => /(?:deploy|sudo|force|delete|exec|output|prefix|directory|work-tree|git-dir|config)/i.test(word))) return false;
  if (words[0] === "git" && ["status", "diff", "log", "show"].includes(words[1])) {
    // No path options, config flags, external diff/textconv, or arbitrary revisions.
    return (words[1] === "status" || (words.includes("--no-ext-diff") && words.includes("--no-textconv"))) && words.slice(2).every(word => /^--(?:short|porcelain(?:=v[12])?|branch|stat|name-only|name-status|oneline|cached|staged|no-ext-diff|no-textconv)$/.test(word));
  }
  return ["npm", "pnpm", "yarn"].includes(words[0]) && words[1] === "test" && words.length === 2;
}
function commandMatches(rule: ApprovalRuleDraft, command: string): boolean {
  if (rule.match === "exact") return command === rule.command;
  if (rule.match === "prefix") return command === rule.command || command.startsWith(rule.command + " ");
  // Bound pattern/command sizes avoid unbounded glob backtracking.
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < command.length) {
    if (i < rule.command.length && (rule.command[i] === "?" || rule.command[i] === command[j])) { i++; j++; }
    else if (rule.command[i] === "*") { star = i++; retry = j; }
    else if (star !== -1) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (rule.command[i] === "*") i++;
  return i === rule.command.length;
}
const auditSchema = z.array(z.object({ at: z.string(), ruleId: z.string().uuid(), owner: z.string(), tool: z.string(), command: z.string(), context: scopeSchema })).max(256);
export async function approvalRuleAudit(root = bridgeRoot()) { return auditSchema.parse(await privateJSON(auditPath(root), [], 4_194_304)); }
/** Fail closed on unrecognized input fields: never implicitly grant changed sandbox policy. */
export async function autoApproveByRule(tool: string, input: unknown, context: ApprovalRuleContext | undefined, root = bridgeRoot()): Promise<boolean> {
  const data = object(input), command = data.command;
  if (!context || typeof command !== "string" || !eligible(tool, command) || Object.keys(data).some(key => !["command", "description", "timeout"].includes(key))) return false;
  try {
    return await locked(root, async () => {
      const { rules } = await readPolicy(root), now = Date.now();
      const matches = [...rules.values()].filter(rule => rule.tool === tool && (!rule.until || Date.parse(rule.until) > now)
        && Object.entries(rule.scope).every(([key, value]) => context[key as keyof ApprovalRuleContext] === value) && commandMatches(rule, command));
      if (matches.some(rule => rule.effect === "always-ask")) return false;
      const rule = matches.find(rule => rule.effect === "allow");
      if (!rule) return false;
      const audit = await approvalRuleAudit(root);
      audit.push({ at: new Date().toISOString(), ruleId: rule.id, owner: rule.owner, tool, command, context });
      await atomic(auditPath(root), JSON.stringify(audit.slice(-256)));
      return true;
    });
  } catch { return false; }
}
/** A card may save only the same authoritative, conservatively eligible request. */
export function approvalRuleSuggestion(tool: string, input: unknown, context: ApprovalRuleContext | undefined): ApprovalRuleDraft | undefined {
  const data = object(input);
  if (!context || typeof data.command !== "string" || !eligible(tool, data.command) || Object.keys(data).some(key => !["command", "description", "timeout"].includes(key))) return undefined;
  return { tool, command: data.command, match: "exact", effect: "allow", projectName: path.basename(context.project), scope: { project: context.project, harness: context.harness } };
}
