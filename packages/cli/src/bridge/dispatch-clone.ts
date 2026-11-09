import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { countGit } from "./metrics.js";
import { gitRoot } from "./projects.js";
import { EMPTY_TREE } from "./launch-worktree.js";
import { credentialFreeRemote, keyedExplicitEnv, removeAgentTokenFile } from "./git-credential.js";
import { detectHost } from "./git-hosts.js";
import { BridgeError, bridgeRoot } from "./protocol.js";
import { workerFilePath } from "./worker-identity.js";

/** A keyed dispatch's isolated checkout. The clone and its managed global
 * config are outside the user's checkout and are removed with the dispatch. */
export interface DispatchClonePaths {
  cloneDir: string;
  gitConfigFile: string;
  agentTokenFile: string;
  /** The wrapper's PID/start-time record, beside the clone. */
  workerFile?: string;
}

export function dispatchClonePaths(dispatchId: string): DispatchClonePaths {
  const root = path.join(bridgeRoot(), "clones");
  const cloneDir = path.join(root, dispatchId);
  return {
    cloneDir,
    gitConfigFile: path.join(root, `${dispatchId}.gitconfig`),
    agentTokenFile: path.join(cloneDir, ".git", "phren-agent-token"),
    workerFile: workerFilePath(dispatchId),
  };
}

const managedRoot = () => path.join(bridgeRoot(), "clones");
async function canonicalManagedRoot(): Promise<string> {
  const root = managedRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}
/** Canonical path inside the managed clone root, or a refusal. */
export async function assertManagedClonePath(candidate: string): Promise<string> {
  const root = await canonicalManagedRoot();
  const resolved = await realpath(candidate).catch(() => path.resolve(candidate));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new BridgeError(403, "The keyed clone path is outside Phren's managed clone folder.");
  }
  return resolved;
}

export interface DispatchClone extends DispatchClonePaths {
  /** Where the agent starts: the same folder inside the clone as the project folder in its repository. */
  cwd: string;
  path: string;
  branch: string;
  discard(): Promise<void>;
}

const exec = promisify(execFile);
async function git(args: string[], env: NodeJS.ProcessEnv = nonInteractiveGitEnv(process.env)): Promise<string> {
  countGit("dispatch-clone");
  return (await exec("git", args, { timeout: 120_000, maxBuffer: 1_048_576, env })).stdout;
}

function configValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

async function userValue(checkout: string, key: "user.name" | "user.email"): Promise<string | undefined> {
  try { return (await git(["-C", checkout, "config", "--get", key])).trim() || undefined; } catch { return undefined; }
}

/** Only the keys a keyed worker may inherit: no user URL-specific overrides. */
export async function writeManagedConfig(file: string, domain: string, checkout: string): Promise<void> {
  await assertManagedClonePath(file);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = [
    "[credential]",
    "\thelper =",
    `[credential "https://${domain}"]`,
    "\thelper = !phren bridge git-credential",
    "\tuseHttpPath = false",
    "[core]",
    "\tsshCommand = false",
    "\thooksPath = /dev/null",
  ];
  const name = await userValue(checkout, "user.name");
  const email = await userValue(checkout, "user.email");
  if (name || email) {
    lines.push("[user]");
    if (name) lines.push(`\tname = ${configValue(name)}`);
    if (email) lines.push(`\temail = ${configValue(email)}`);
  }
  await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
}

/** The start folder inside the clone, refusing a symlink or a path that escapes it. */
export async function cloneStartDirectory(cloneDir: string, root: string, checkout: string): Promise<string> {
  const clone = await realpath(cloneDir);
  const inside = path.relative(root, await realpath(checkout));
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return clone;
  const candidate = path.join(clone, inside);
  const info = await lstat(candidate).catch(() => undefined);
  if (!info) return clone;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError(409, "The project folder in the keyed clone is a symlink or not a directory.");
  const real = await realpath(candidate);
  const rel = path.relative(clone, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new BridgeError(403, "The project folder in the keyed clone points outside it.");
  return real;
}

/** A fresh clone with only our managed global config, never the user's checkout config. */
export async function createDispatchClone(checkout: string, request: { branch: string; dispatchId: string; paths?: DispatchClonePaths }): Promise<DispatchClone> {
  const root = await gitRoot(checkout);
  if (!root) throw new BridgeError(409, "This folder is not a Git repository, so it cannot be cloned for a keyed dispatch.");
  const host = await detectHost(checkout, request.branch);
  if (host.kind !== "gitboy" || !host.domain) throw new BridgeError(409, "A keyed worktree dispatch needs a gitboy checkout.");
  const url = credentialFreeRemote(host);
  const paths = request.paths ?? dispatchClonePaths(request.dispatchId);
  await assertManagedClonePath(paths.cloneDir);
  await assertManagedClonePath(paths.gitConfigFile);
  await assertManagedClonePath(paths.agentTokenFile);
  if (await stat(paths.cloneDir).then(() => true, () => false)) throw new BridgeError(409, "This dispatch's clone folder already exists.");
  await mkdir(path.dirname(paths.cloneDir), { recursive: true, mode: 0o700 });
  await writeManagedConfig(paths.gitConfigFile, host.domain, checkout);
  const env = keyedExplicitEnv(process.env, {
    GIT_CONFIG_GLOBAL: paths.gitConfigFile,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    SSH_ASKPASS: "false",
  });
  try {
    await git(["-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--reference-if-able", root, "--dissociate", url, paths.cloneDir], env);
    await git(["-C", paths.cloneDir, "-c", "core.hooksPath=/dev/null", `--attr-source=${EMPTY_TREE}`, "checkout", "-b", request.branch], env);
  } catch (error) {
    await rm(paths.cloneDir, { recursive: true, force: true }).catch(() => undefined);
    await unlink(paths.gitConfigFile).catch(() => undefined);
    const detail = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").at(-1) : "";
    throw new BridgeError(409, `Git could not create the keyed clone${detail ? `: ${detail.replace(/^fatal:\s*/, "")}` : "."}`);
  }
  const clone = await realpath(paths.cloneDir);
  const cwd = await cloneStartDirectory(clone, root, checkout);
  return {
    ...paths,
    cwd,
    path: clone,
    branch: request.branch,
    async discard() {
      await removeDispatchClone(paths);
    },
  };
}

/** Remove a dispatch's clone, managed config and token file; only paths this Hook made. */
export async function removeDispatchClone(paths: Partial<DispatchClonePaths> | undefined): Promise<void> {
  if (!paths) return;
  const remove = async (candidate: string | undefined, removeOne: (canonical: string) => Promise<void>) => {
    if (!candidate) return;
    try { await removeOne(await assertManagedClonePath(candidate)); } catch { /* outside the managed root: never touch it */ }
  };
  await remove(paths.cloneDir, canonical => rm(canonical, { recursive: true, force: true }));
  await remove(paths.gitConfigFile, canonical => unlink(canonical));
  await remove(paths.agentTokenFile, canonical => removeAgentTokenFile(canonical));
  await remove(paths.workerFile, canonical => unlink(canonical));
}

/** Keep the clone (recoverable work) but remove the token and managed config immediately. */
export async function removeDispatchSecrets(paths: Partial<DispatchClonePaths> | undefined): Promise<void> {
  if (!paths) return;
  const remove = async (candidate: string | undefined, removeOne: (canonical: string) => Promise<void>) => {
    if (!candidate) return;
    try { await removeOne(await assertManagedClonePath(candidate)); } catch { /* outside the managed root: never touch it */ }
  };
  await remove(paths.gitConfigFile, canonical => unlink(canonical));
  await remove(paths.agentTokenFile, canonical => removeAgentTokenFile(canonical));
}
