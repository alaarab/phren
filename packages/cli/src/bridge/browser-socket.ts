import { createHash } from "node:crypto";
import path from "node:path";
import { bridgeRoot } from "./protocol.js";

/** One endpoint per Hook root; Windows pipes live outside the filesystem. */
export function browserSocketPath(root = bridgeRoot()): string {
  if (process.platform !== "win32") return path.join(root, "browser.sock");
  const id = createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex");
  return String.raw`\\.\pipe\phren-browser-${id}`;
}
