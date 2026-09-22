import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./protocol.js";

export const MAX_FILE_RANGE = 4 * 1024 * 1024;

const types: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", aiff: "audio/aiff", flac: "audio/flac", ogg: "audio/ogg",
  pdf: "application/pdf", json: "application/json", csv: "text/csv", md: "text/markdown", markdown: "text/markdown",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", svg: "image/svg+xml",
  txt: "text/plain", log: "text/plain", yaml: "text/yaml", yml: "text/yaml", xml: "text/xml",
};
export function fileContentType(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return types[ext] ?? (/^(ts|tsx|js|jsx|swift|py|rs|go|rb|sh|bash|zsh|c|h|cpp|hpp|cs|java|kt|html|css|scss|sql|toml|ini)$/.test(ext)
    ? "text/plain" : "application/octet-stream");
}

function version(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function rangeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BridgeError(400, "Invalid file range.");
  return Number(value);
}

/** Roots are selected by the server, never supplied unchecked by the phone.
 * A zero length request checks existence and metadata without reading bytes.
 * Reject every symlink component, matching the repository browser policy. */
export async function readFileRange(root: string, requested: string, offset: number, length: number, expectedVersion?: string) {
  if (!requested || requested.length > 4096 || /[\x00-\x1f\x7f\\]/.test(requested)
      || requested.split("/").some(part => part === ".." || part === ".git")) throw new BridgeError(400, "Invalid file path.");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_RANGE) {
    throw new BridgeError(400, "File ranges must be between 0 and 4 MiB.");
  }
  try {
    const base = await realpath(root);
    const relative = path.isAbsolute(requested) ? path.relative(base, requested) : requested;
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new BridgeError(403, "This file is outside the allowed folder.");
    let file = base;
    for (const part of relative.split(path.sep).filter(part => part && part !== ".")) {
      file = path.join(file, part);
      if ((await lstat(file)).isSymbolicLink()) throw new BridgeError(403, "Symbolic links cannot be opened.");
    }
    const resolved = await realpath(file);
    if (!resolved.startsWith(base + path.sep)) throw new BridgeError(403, "This file is outside the allowed folder.");
    const metadata = await lstat(resolved);
    if (!metadata.isFile()) throw new BridgeError(400, "Only regular files can be opened.");
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      // Recheck the name after opening, including parent directory replacements.
      if (!current.isFile() || version(current) !== version(metadata) || await realpath(file) !== resolved) {
        throw new BridgeError(409, "The file changed. Open it again.");
      }
      const revision = version(current);
      if (expectedVersion !== undefined && expectedVersion !== revision) throw new BridgeError(409, "The file changed. Open it again.");
      if (offset > current.size) throw new BridgeError(416, "The offset is past the end of this file.");
      const bytes = Buffer.alloc(Math.min(length, current.size - offset));
      let read = 0;
      while (read < bytes.length) {
        const next = await handle.read(bytes, read, bytes.length - read, offset + read);
        if (!next.bytesRead) break;
        read += next.bytesRead;
      }
      if (version(await handle.stat()) !== revision || read !== bytes.length) throw new BridgeError(409, "The file changed. Open it again.");
      return { path: requested, offset, length: read, total: current.size, contentType: fileContentType(file),
        version: revision, eof: offset + read === current.size, data: bytes.toString("base64") };
    } finally { await handle.close(); }
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new BridgeError(404, "This file is no longer available.");
    throw error;
  }
}
