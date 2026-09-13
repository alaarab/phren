import { mkdir, readdir, lstat, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bridgeRoot, BridgeError, MAX_FRAME } from "./protocol.js";

export function imageBytes(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    || /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
    || (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
}

export const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
let uploadQueue = Promise.resolve();
/** Stores a file the phone sent under uploads/<session>/. A name with an
 * image extension must hold image bytes; anything else is kept as-is. */
export async function saveUpload(session: string, name: string, bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_FRAME) throw new BridgeError(400, "The file is empty or too large.");
  if (IMAGE_NAME.test(name) && !imageBytes(bytes)) throw new BridgeError(400, "Choose a PNG, JPEG, GIF, or WebP image.");
  let saved = "";
  const task = uploadQueue.catch(() => {}).then(async () => {
    const root = path.join(bridgeRoot(), "uploads");
    await mkdir(root, { recursive: true, mode: 0o700 });
    let used = 0;
    const directories = await readdir(root, { withFileTypes: true });
    for (const dir of directories) {
      if (!dir.isDirectory()) continue;
      const folder = path.join(root, dir.name);
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = path.join(folder, entry.name), metadata = await lstat(file);
        if (Date.now() - metadata.mtimeMs > 14 * 86400_000) await unlink(file);
        else used += metadata.size;
      }
    }
    if (used + bytes.length > 268_435_456) throw new BridgeError(413, "Phren's image storage is full. Remove older uploads on the computer.");
    const folder = path.join(root, session);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    saved = path.join(folder, `${randomUUID()}-${name}`);
    await writeFile(saved, bytes, { flag: "wx", mode: 0o600 });
  });
  uploadQueue = task;
  await task;
  return saved;
}

/** What the phone has put in one folder, newest first. */
export async function listUploads(session: string): Promise<{ name: string; path: string; size: number; modified: string }[]> {
  const folder = path.join(bridgeRoot(), "uploads", session);
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const files: { name: string; path: string; size: number; modified: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(folder, entry.name), metadata = await stat(file);
    files.push({ name: entry.name.replace(/^[0-9a-f-]{36}-/, ""), path: file, size: metadata.size, modified: metadata.mtime.toISOString() });
  }
  return files.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 200);
}
