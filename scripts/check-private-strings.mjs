#!/usr/bin/env node
// Fails when a tracked file contains one of the owner's private strings:
// home paths, hostnames, the tailnet name, IPs, emails, SSH host keys, work
// names. The list is stored as SHA-256 hashes so this public repo does not
// publish the strings it guards against.
//
// Each line of scripts/private-strings.sha256 is `<hash> [allowed-path ...]`.
// A hash is the SHA-256 of the lowercased token. Add one with:
//   node scripts/check-private-strings.mjs --hash 'Some-Hostname'
// Tokens are emails, `users/<name>` and `home/<name>` path pairs (either
// slash, so Windows paths count), IPv4 addresses, SSH key blobs, and words of
// letters, digits and hyphens.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const LIST = "scripts/private-strings.sha256";
const sha = (text) => createHash("sha256").update(text.toLowerCase()).digest("hex");

if (process.argv[2] === "--hash") {
  for (const value of process.argv.slice(3)) console.log(sha(value));
  process.exit(0);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const guarded = new Map();
for (const line of readFileSync(path.join(root, LIST), "utf8").split("\n")) {
  const [hash, ...allowed] = line.trim().split(/\s+/);
  if (/^[0-9a-f]{64}$/.test(hash ?? "")) guarded.set(hash, allowed);
}

const TOKEN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b(?:users|home)[\\/]+[a-z0-9_.-]+|\b\d{1,3}(?:\.\d{1,3}){3}\b|aaaa[a-z0-9+/]{40,}={0,2}|[a-z0-9]+(?:-[a-z0-9]+)*/g;
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\0").filter(file => file && file !== LIST);

const hits = [];
for (const file of files) {
  let text;
  try { text = readFileSync(path.join(root, file)); } catch { continue; }
  if (text.includes(0)) continue; // binary
  const lines = text.toString("utf8").toLowerCase().split("\n");
  lines.forEach((line, index) => {
    const seen = new Set(line.match(TOKEN));
    for (const token of seen) {
      const allowed = guarded.get(sha(token.replace(/[\\/]+/g, "/")));
      if (allowed && !allowed.some(prefix => file.startsWith(prefix))) hits.push(`${file}:${index + 1}`);
    }
  });
}

if (hits.length > 0) {
  console.error(`Private strings found (owner hostnames, paths, emails, IPs, keys or work names; see ${LIST}):`);
  for (const hit of [...new Set(hits)]) console.error(`  ${hit}`);
  console.error("Replace them with placeholders such as user@example.com, /Users/me, example-host or 100.64.0.1.");
  process.exit(1);
}
console.log(`No private strings in ${files.length} tracked files.`);
