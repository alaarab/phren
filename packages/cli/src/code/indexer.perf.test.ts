import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { indexProject } from "./indexer.js";

/**
 * Cold index of a synthetic 100k-line TypeScript project under 20 s, then one
 * changed file under 200 ms. Gated on PHREN_PERF=1 because it writes ~3 MB and
 * hashes the whole project twice.
 */

const worktreeRoot = path.resolve(__dirname, "../../../..");
const scratch = path.join(worktreeRoot, ".scratch", "code-perf");
const repo = path.join(scratch, "repo");
const store = path.join(scratch, "store");
const FILE_COUNT = 20;
const FUNCTIONS_PER_FILE = 1000;

function makeFile(index: number): string {
  const lines: string[] = [`// synthetic perf file ${index}`];
  for (let i = 0; i < FUNCTIONS_PER_FILE; i++) {
    lines.push(`export function f${index}_${i}(value: number): number {`);
    lines.push("  const doubled = value * 2;");
    lines.push(`  return ${i === 0 ? "doubled" : `f${index}_${i - 1}(doubled)`};`);
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n");
}

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=Perf Author", "-c", "user.email=perf@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
}

describe.skipIf(process.env.PHREN_PERF !== "1")("code index performance", () => {
  afterAll(() => {
    if (!process.env.PHREN_KEEP_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("indexes 100k lines cold in under 20 s and one changed file in under 200 ms", async () => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(repo, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < FILE_COUNT; index++) {
      const file = path.join(repo, `module-${index}.ts`);
      fs.writeFileSync(file, makeFile(index));
      files.push(file);
    }
    const totalLines = FILE_COUNT * (FUNCTIONS_PER_FILE * 5 + 1);
    expect(totalLines).toBeGreaterThanOrEqual(100_000);

    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "synthetic");

    const coldStart = performance.now();
    const cold = await indexProject(store, "synthetic", { repoRoot: repo });
    const coldMs = performance.now() - coldStart;
    expect(cold.files).toBe(FILE_COUNT);
    expect(cold.symbols).toBeGreaterThan(FILE_COUNT * FUNCTIONS_PER_FILE);
    expect(coldMs, `cold index took ${Math.round(coldMs)}ms`).toBeLessThan(20_000);

    fs.appendFileSync(files[0], "export function added(value: number): number { return value; }\n");
    const warmStart = performance.now();
    const warm = await indexProject(store, "synthetic", { repoRoot: repo });
    const warmMs = performance.now() - warmStart;
    expect(warm.parsed).toBe(1);
    expect(warmMs, `incremental index took ${Math.round(warmMs)}ms`).toBeLessThan(200);
  });
});
