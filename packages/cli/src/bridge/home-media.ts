import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileContentType, readFileRange } from "./file-range.js";
import { BridgeError } from "./protocol.js";

/** Chat links to a video, audio file or picture outside the pane's
 * repository (a render in `~/videos/out`, a pane whose folder is no
 * repository) open from the Hook user's home folder, read-only. The phone
 * gets the file as `~/<path>` and asks for its ranges by that name. Only
 * media, never a name part starting with '.' (`~/.ssh`, `~/.config`, `.git`),
 * and the range reader's no-symlink walk. */
export const HOME_PREFIX = "~/";

export function isHomeMediaPath(requested: string): boolean {
  return requested.startsWith(HOME_PREFIX);
}

function isMedia(file: string): boolean {
  return /^(video|audio|image)\//.test(fileContentType(file));
}

/** A name part that is or may stand for a hidden one: a leading '.', after
 * the code points HFS+ ignores; an NTFS short name (`SSH~1` for `.ssh`); `~`;
 * an NTFS stream (`:`). */
function hiddenPart(part: string): boolean {
  return part.replace(/[\u200c-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").startsWith(".") || /~\d|^~$|:/.test(part);
}

/** `relative` (slash-separated, beneath home) when it names media and no
 * part is hidden; undefined otherwise. */
function mediaRelative(relative: string): string | undefined {
  const parts = relative.split("/").filter(part => part && part !== ".");
  if (!parts.length || parts.some(hiddenPart) || !isMedia(parts.at(-1)!)) return undefined;
  return parts.join("/");
}

async function homeRoots(home: string): Promise<{ base: string; spellings: string[] }> {
  const base = await realpath(home);
  return { base, spellings: [...new Set([base, path.resolve(home)])].map(value => value.split(path.sep).join("/")) };
}

/** Metadata for a home media file named by an absolute path, or by a
 * relative one read from `cwd` (which must itself be beneath home). Undefined
 * when the name is not home media, so the caller keeps its own answer. */
export async function resolveHomeMedia(requested: string, cwd: string | undefined) {
  if (requested.split("/").includes("..")) return undefined;
  const { base, spellings } = await homeRoots(homedir());
  let relative: string | undefined;
  if (path.isAbsolute(requested)) {
    const alias = spellings.find(candidate => requested.startsWith(candidate + "/"));
    relative = alias ? requested.slice(alias.length + 1) : undefined;
  } else if (cwd) {
    const folder = path.relative(base, await realpath(cwd)).split(path.sep).join("/");
    if (folder !== ".." && !folder.startsWith("../") && !path.isAbsolute(folder)) relative = folder ? `${folder}/${requested}` : requested;
  }
  const name = relative === undefined ? undefined : mediaRelative(relative);
  if (!name) return undefined;
  const metadata = await readFileRange(base, name, 0, 0);
  return { path: HOME_PREFIX + name, size: metadata.total, contentType: metadata.contentType, version: metadata.version };
}

/** A range of `~/<path>` as `resolveHomeMedia` named it. */
export async function readHomeMedia(requested: string, offset: number, length: number, expectedVersion?: string) {
  const name = isHomeMediaPath(requested) ? mediaRelative(requested.slice(HOME_PREFIX.length)) : undefined;
  if (!name || requested.split("/").includes("..")) throw new BridgeError(403, "Only pictures, audio and video in the home folder can be opened.");
  const { base } = await homeRoots(homedir());
  return { ...await readFileRange(base, name, offset, length, expectedVersion), path: requested };
}
