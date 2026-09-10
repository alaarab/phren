import { mkdir, readdir, lstat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bridgeRoot, BridgeError, MAX_FRAME } from "./protocol.js";

export function imageBytes(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    || /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
    || (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
}

let uploadQueue = Promise.resolve();
export async function saveUpload(session: string, name: string, bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_FRAME || !imageBytes(bytes)) throw new BridgeError(400, "Choose a PNG, JPEG, GIF, or WebP image.");
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
