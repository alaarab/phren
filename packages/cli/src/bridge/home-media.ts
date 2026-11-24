import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileContentType, readFileRange } from "./file-range.js";
import { BridgeError, bridgeRoot } from "./protocol.js";

/** Chat links to a video, audio file or picture outside the pane's
 * repository (a render in `~/videos/out`, a pane whose folder is no
 * repository) open read-only from a media root: the Hook user's home folder,
 * on WSL the Windows drives (`/mnt/c`, `/mnt/d`), and the folders listed in
 * `<bridge>/media-roots`. The phone gets the file as `~/<path>` (home) or
 * `~root/<root>/<path>` (any other root, its absolute path without the
 * leading `/`, a Windows drive as `D/...`) and asks for its ranges by that
 * name. Only media, never a name part starting with '.' (`~/.ssh`,
 * `~/.config`), and the range reader's no-symlink walk. */
export const HOME_PREFIX = "~/";
export const ROOT_PREFIX = "~root/";
/** One absolute folder per line; blank lines and `#` comments are skipped. */
const MEDIA_ROOTS_FILE = "media-roots";

export function isMediaPath(requested: string): boolean {
  return requested.startsWith(HOME_PREFIX) || requested.startsWith(ROOT_PREFIX);
}

const slashed = (value: string) => value.split(path.sep).join("/");
/** `c:/x` and `C:/x` are one file on Windows; roots are compared upper-case. */
export const upperDrive = (value: string) => value.replace(/^([a-z]):(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`);

function isMedia(file: string): boolean {
  return /^(video|audio|image)\//.test(fileContentType(file));
}

/** A name part that is or may stand for a hidden one: a leading '.', after
 * the code points HFS+ ignores; an NTFS short name (`SSH~1` for `.ssh`); `~`;
 * an NTFS stream (`:`). */
function hiddenPart(part: string): boolean {
  return part.replace(/[\u200c-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").startsWith(".") || /~\d|^~$|:/.test(part);
}

/** `relative` (slash-separated, beneath a root) when it names media and no
 * part is hidden; undefined otherwise. */
function mediaRelative(relative: string): string | undefined {
  const parts = relative.split("/").filter(part => part && part !== ".");
  if (!parts.length || parts.some(hiddenPart) || !isMedia(parts.at(-1)!)) return undefined;
  return parts.join("/");
}

/** The Windows drives WSL mounts (`/mnt/c`, `/mnt/d`), not its own `/mnt/wsl`. */
async function wslDrives(): Promise<string[]> {
  if (wsl === undefined) {
    const version = await readFile("/proc/version", "utf8").catch(() => "");
    wsl = process.platform === "linux" && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(version));
  }
  if (!wsl) return [];
  const entries = await readdir("/mnt", { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => /^[a-z]$/i.test(entry.name) && entry.isDirectory()).map(entry => path.join("/mnt", entry.name));
}
let wsl: boolean | undefined;

async function configuredRoots(): Promise<string[]> {
  const text = await readFile(path.join(bridgeRoot(), MEDIA_ROOTS_FILE), "utf8").catch(() => "");
  return text.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(line => line && path.isAbsolute(line));
}

interface MediaRoot { base: string; spellings: string[]; prefix: string }

/** Home first, then the WSL drives, then the configured folders; folders
 * that do not exist are left out. */
async function mediaRoots(): Promise<MediaRoot[]> {
  const folders = [homedir(), ...await wslDrives(), ...await configuredRoots()];
  const roots: MediaRoot[] = [];
  for (const [index, folder] of folders.entries()) {
    const base = await realpath(folder).catch(() => undefined);
    if (!base || roots.some(root => root.base === base)) continue;
    const spellings = [...new Set([base, path.resolve(folder)].map(value => upperDrive(slashed(value)).replace(/\/$/, "")))];
    const name = upperDrive(slashed(base)).replace(/^([A-Z]):/, "$1").replace(/^\/|\/$/g, "");
    roots.push({ base, spellings, prefix: index === 0 ? HOME_PREFIX : ROOT_PREFIX + (name ? name + "/" : "") });
  }
  return roots;
}

/** A bare file name (`clip.mp4`) not in the pane's folder: the newest file of
 * that name beneath it, at most four folders down, within a fixed number of
 * folders and time; hidden folders, symlinks and dependency or system
 * folders are not entered. */
const SEARCH_DEPTH = 4, SEARCH_FOLDERS = 400, SEARCH_MS = 500;
const SKIPPED = new Set(["node_modules", "Library", "AppData", "$RECYCLE.BIN", "System Volume Information"]);
async function findByName(base: string, start: string, name: string): Promise<string | undefined> {
  const deadline = Date.now() + SEARCH_MS, queue = [{ folder: start, depth: 0 }];
  let read = 0, best: { relative: string; mtimeMs: number } | undefined;
  while (queue.length && read++ < SEARCH_FOLDERS && Date.now() < deadline) {
    const { folder, depth } = queue.shift()!;
    const entries = await readdir(path.join(base, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (hiddenPart(entry.name) || entry.isSymbolicLink()) continue;
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < SEARCH_DEPTH && !SKIPPED.has(entry.name)) queue.push({ folder: relative, depth: depth + 1 });
      } else if (entry.isFile() && entry.name === name) {
        const { mtimeMs } = await stat(path.join(base, relative)).catch(() => ({ mtimeMs: -1 }));
        if (mtimeMs >= 0 && (!best || mtimeMs > best.mtimeMs)) best = { relative, mtimeMs };
      }
    }
  }
  return best?.relative;
}

const notFound = (error: unknown) => error instanceof BridgeError && error.status === 404;

/** Metadata for a media file named by an absolute path, or by a relative one
 * read from `cwd` (which must itself be beneath a media root). Undefined when
 * the name is no media in a root, so the caller keeps its own answer. */
export async function resolveMedia(requested: string, cwd: string | undefined) {
  if (requested.split("/").includes("..")) return undefined;
  const roots = await mediaRoots();
  const candidates: { root: MediaRoot; relative: string; folder?: string }[] = [];
  if (path.isAbsolute(requested)) {
    for (const root of roots) {
      const alias = root.spellings.find(candidate => requested.startsWith(candidate + "/"));
      if (alias) candidates.push({ root, relative: requested.slice(alias.length + 1) });
    }
  } else if (cwd) {
    const real = await realpath(cwd);
    for (const root of roots) {
      const folder = slashed(path.relative(root.base, real));
      if (folder === ".." || folder.startsWith("../") || path.isAbsolute(folder)) continue;
      candidates.push({ root, relative: folder ? `${folder}/${requested}` : requested, folder });
    }
  }
  let missing: unknown;
  for (const { root, relative, folder } of candidates) {
    let name = mediaRelative(relative);
    if (!name) continue;
    const answer = async (file: string) => {
      const metadata = await readFileRange(root.base, file, 0, 0);
      return { path: root.prefix + file, size: metadata.total, contentType: metadata.contentType, version: metadata.version };
    };
    try { return await answer(name); } catch (error) {
      if (!notFound(error)) throw error;
      missing ??= error;
    }
    if (folder !== undefined && !requested.includes("/")) {
      name = await findByName(root.base, folder, requested);
      if (name) return answer(name);
    }
  }
  if (missing) throw missing;
  return undefined;
}

/** A range of a media file as `resolveMedia` named it. */
export async function readMedia(requested: string, offset: number, length: number, expectedVersion?: string) {
  if (!requested.split("/").includes("..")) {
    for (const root of isMediaPath(requested) ? await mediaRoots() : []) {
      const name = requested.startsWith(root.prefix) ? mediaRelative(requested.slice(root.prefix.length)) : undefined;
      if (name) return { ...await readFileRange(root.base, name, offset, length, expectedVersion), path: requested };
    }
  }
  throw new BridgeError(403, "Only pictures, audio and video in the home folder or a media folder can be opened.");
}
