import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { BridgeError, bridgeRoot, type Json } from "./protocol.js";

// The phone reads memory from a paired computer through these routes, in the
// same git terms its sync engine uses with GitHub: a head, a recursive tree,
// blobs by sha, and compare-and-swap file writes. The head is the store's
// working tree (committed or not), so the phone sees what agents on this
// computer see, and .gitignore keeps machine-local files off the phone.

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const MAX_FILE = 4 * 1024 * 1024;
let queue: Promise<unknown> = Promise.resolve();

/** Serialize git work on the snapshot index; two phone polls share one index. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function git(store: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", store, ...args], {
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    throw new BridgeError(500, `git ${args[0]} failed in the store${stderr ? `: ${stderr.split("\n")[0]}` : "."}`);
  }
}

/** The sha git gives these bytes as a blob; GitHub reports the same one. */
export function blobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

async function isRepository(store: string): Promise<boolean> {
  return (await lstat(path.join(store, ".git")).catch(() => undefined)) !== undefined;
}

/** A tree sha for the store's current working tree, written through a private index. */
export function storeHead(store: string, indexFile = path.join(bridgeRoot(), "store-snapshot.index")): Promise<{ sha: string }> {
  return serialized(async () => {
    if (!await isRepository(store)) throw new BridgeError(409, "This computer's phren store is not a git repository. Run phren init.");
    await mkdir(path.dirname(indexFile), { recursive: true, mode: 0o700 });
    const env = { GIT_INDEX_FILE: indexFile };
    if (!await lstat(indexFile).catch(() => undefined)) {
      const head = await git(store, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
      await git(store, head.trim() ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], env);
    }
    await git(store, ["add", "--all", "--", "."], env);
    return { sha: (await git(store, ["write-tree"], env)).trim() };
  });
}

/** The recursive tree for a head, with the fields the phone's GitTree decodes. */
export async function storeTree(store: string, sha: string): Promise<Json> {
  if (!SHA.test(sha)) throw new BridgeError(400, "Invalid tree sha.");
  if ((await git(store, ["cat-file", "-t", sha]).catch(() => "")).trim() !== "tree") throw new BridgeError(404, "Unknown tree.");
  const tree = (await git(store, ["ls-tree", "-r", "-l", "-z", sha])).split("\0").filter(Boolean).flatMap(line => {
    const match = /^(\d+) (\w+) ([0-9a-f]{40}) +(\d+|-)\t(.+)$/s.exec(line);
    // Symlinks and submodules never reach the phone.
    if (!match || match[2] !== "blob" || match[1] === "120000") return [];
    return [{ path: match[5], type: "blob", sha: match[3], size: Number(match[4]) }];
  });
  return { sha, truncated: false, tree };
}

export async function storeBlob(store: string, sha: string): Promise<Json> {
  if (!SHA.test(sha)) throw new BridgeError(400, "Invalid blob sha.");
  if ((await git(store, ["cat-file", "-t", sha]).catch(() => "")).trim() !== "blob") throw new BridgeError(404, "Unknown blob.");
  const { stdout } = await exec("git", ["-C", store, "cat-file", "blob", sha], { encoding: "buffer", maxBuffer: MAX_FILE * 4 });
  return { sha, encoding: "base64", content: stdout.toString("base64") };
}

/** Resolve a store-relative path, refusing escapes, .git and symlinked parents. */
export async function storeFile(store: string, relative: string): Promise<string> {
  const normalized = path.posix.normalize(relative);
  if (!relative || relative !== normalized || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)
      || normalized.split("/").some(part => part === ".git" || part === "" || part === ".") || /[\0\r\n]/.test(normalized)) {
    throw new BridgeError(400, "Invalid store path.");
  }
  const root = await realpath(store);
  let parent = path.dirname(path.join(root, normalized));
  // Missing parents are created later; the nearest existing one must stay inside the store.
  for (;;) {
    const real = await realpath(parent).catch(() => undefined);
    if (real) { if (real !== root && !real.startsWith(root + path.sep)) throw new BridgeError(400, "Invalid store path."); break; }
    parent = path.dirname(parent);
  }
  const file = path.join(root, normalized);
  const info = await lstat(file).catch(() => undefined);
  if (info && !info.isFile()) throw new BridgeError(400, "Invalid store path.");
  return file;
}

async function currentSha(file: string): Promise<string | null> {
  const content = await readFile(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return content === null ? null : blobSha(content);
}

const putSchema = z.object({ path: z.string().max(1024), content: z.string(), sha: z.string().regex(SHA).nullable().optional() });
const deleteSchema = z.object({ path: z.string().max(1024), sha: z.string().regex(SHA) });

/** Write one file if it still has the sha the phone last saw (null: must not exist). */
export function putStoreFile(store: string, data: Json): Promise<Json> {
  const input = putSchema.parse(data);
  const content = Buffer.from(input.content, "base64");
  if (content.length > MAX_FILE) throw new BridgeError(413, "This file is too large for the phone to write.");
  return serialized(async () => {
    const file = await storeFile(store, input.path);
    if (await currentSha(file) !== (input.sha ?? null)) throw new BridgeError(409, `${input.path} changed on this computer.`);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.phren-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
    return { content: { sha: blobSha(content), path: input.path }, commit: { sha: blobSha(content) } };
  });
}

export function deleteStoreFile(store: string, data: Json): Promise<Json> {
  const input = deleteSchema.parse(data);
  return serialized(async () => {
    const file = await storeFile(store, input.path);
    if (await currentSha(file) !== input.sha) throw new BridgeError(409, `${input.path} changed on this computer.`);
    await rm(file);
    return { ok: true };
  });
}

export const STORE_ROUTES = { head: "/v1/store/head", tree: "/v1/store/tree", blob: "/v1/store/blob", file: "/v1/store/file", delete: "/v1/store/delete" } as const;

export async function storeRoute(store: string, method: string, url: URL, data?: Json): Promise<Json> {
  if (method === "GET" && url.pathname === STORE_ROUTES.head) return storeHead(store);
  if (method === "GET" && url.pathname === STORE_ROUTES.tree) return storeTree(store, url.searchParams.get("sha") ?? "");
  if (method === "GET" && url.pathname === STORE_ROUTES.blob) return storeBlob(store, url.searchParams.get("sha") ?? "");
  if (method === "POST" && url.pathname === STORE_ROUTES.file) return putStoreFile(store, data ?? {});
  if (method === "POST" && url.pathname === STORE_ROUTES.delete) return deleteStoreFile(store, data ?? {});
  throw new BridgeError(404, "Unknown Phren Hook route.");
}
