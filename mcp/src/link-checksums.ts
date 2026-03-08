import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getProjectDirs } from "./shared.js";

interface ChecksumStore {
  [relativePath: string]: { sha256: string; updatedAt: string };
}

function fileChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function checksumStorePath(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "file-checksums.json");
}

function loadChecksums(cortexPath: string): ChecksumStore {
  const file = checksumStorePath(cortexPath);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveChecksums(cortexPath: string, store: ChecksumStore): void {
  const file = checksumStorePath(cortexPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n");
}

export function updateFileChecksums(cortexPath: string, profileName?: string): { updated: number; files: string[] } {
  const store = loadChecksums(cortexPath);

  // Migrate legacy CANONICAL.md checksum keys to CANONICAL_MEMORIES.md
  for (const key of Object.keys(store)) {
    if (key.endsWith("/CANONICAL.md")) {
      const newKey = key.replace(/\/CANONICAL\.md$/, "/CANONICAL_MEMORIES.md");
      if (!store[newKey]) store[newKey] = store[key];
      delete store[key];
    }
  }

  const now = new Date().toISOString();
  const tracked: string[] = [];
  const dirs = getProjectDirs(cortexPath, profileName);
  for (const dir of dirs) {
    for (const name of ["FINDINGS.md", "backlog.md", "CANONICAL_MEMORIES.md"]) {
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) continue;
      const rel = path.relative(cortexPath, full).replace(/\\/g, "/");
      store[rel] = { sha256: fileChecksum(full), updatedAt: now };
      tracked.push(rel);
    }
  }
  saveChecksums(cortexPath, store);
  return { updated: tracked.length, files: tracked };
}

export function verifyFileChecksums(cortexPath: string): Array<{ file: string; status: "ok" | "mismatch" | "missing" }> {
  const store = loadChecksums(cortexPath);
  const results: Array<{ file: string; status: "ok" | "mismatch" | "missing" }> = [];
  for (const [rel, entry] of Object.entries(store)) {
    const full = path.join(cortexPath, rel);
    if (!fs.existsSync(full)) {
      results.push({ file: rel, status: "missing" });
      continue;
    }
    const current = fileChecksum(full);
    results.push({ file: rel, status: current === entry.sha256 ? "ok" : "mismatch" });
  }
  return results;
}
