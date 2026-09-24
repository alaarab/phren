import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { hookRequest } from "../bridge/client.js";
import { AccountUsageReader, type AccountUsage } from "../bridge/usage.js";
import type { ProviderError } from "./picker.js";

export async function readUsage(): Promise<AccountUsage[]> {
  try {
    const value = await hookRequest("/v1/usage?sources=codex,claude,opencode,opencode-go,openrouter", undefined, undefined, 2_000);
    if (Array.isArray(value.accounts)) return value.accounts as unknown as AccountUsage[];
  } catch { /* Same readers when the local Hook is unavailable. */ }
  return (await new AccountUsageReader().read()).accounts;
}
export function parseProviderErrors(text: string, now = Date.now()): ProviderError[] {
  const result: ProviderError[] = [];
  for (const line of text.split("\n")) {
    if (!/(Go usage limit exceeded|Rate limit exceeded)/i.test(line)) continue;
    const stamp = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(line)?.[0];
    const at = stamp ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(at) || at > now || now - at > 3_600_000) continue;
    const provider = /(?:providerID|provider)["\s:=]+([a-z0-9-]+)/i.exec(line)?.[1] ?? (/Go usage limit/i.test(line) ? "opencode-go" : undefined);
    if (provider) result.push({ provider, at, message: /Go usage limit exceeded/i.test(line) ? "Go usage limit exceeded" : "Rate limit exceeded" });
  }
  return result;
}
export function recentProviderErrors(now = Date.now()): ProviderError[] {
  const root = path.join(process.env.OPENCODE_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "opencode"), "log");
  try {
    return fs.readdirSync(root).flatMap(name => {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs > 3_600_000) return [];
      const fd = fs.openSync(file, "r");
      try { const data = Buffer.alloc(Math.min(stat.size, 1_048_576)); fs.readSync(fd, data, 0, data.length, Math.max(0, stat.size - data.length)); return parseProviderErrors(data.toString("utf8"), now); }
      finally { fs.closeSync(fd); }
    });
  } catch { return []; }
}
