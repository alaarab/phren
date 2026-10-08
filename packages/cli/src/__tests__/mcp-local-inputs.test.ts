import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir, writeFile } from "../test-helpers.js";

const io = vi.hoisted(() => ({ reads: 0, lists: 0 }));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual,
    readFileSync: (...args: unknown[]) => { io.reads++; return (actual.readFileSync as (...a: unknown[]) => unknown)(...args); },
    readdirSync: (...args: unknown[]) => { io.lists++; return (actual.readdirSync as (...a: unknown[]) => unknown)(...args); },
  };
});
const { captureIndexInputs, buildIndex } = await import("../shared/index.js");
const fs = await import("fs");
let tmp: ReturnType<typeof makeTempDir> | undefined;
afterEach(() => { tmp?.cleanup(); tmp = undefined; });

it("checks known metadata without rereading or listing unchanged content", async () => {
  tmp = makeTempDir("mcp-inputs-");
  writeFile(path.join(tmp.path, "demo", "summary.md"), "# Demo\nOriginal summary.\n");
  const fresh = await captureIndexInputs(tmp.path);
  io.reads = io.lists = 0;
  expect(fresh()).toBe(true);
  expect(fresh()).toBe(true);
  expect(io).toEqual({ reads: 0, lists: 0 });
  writeFile(path.join(tmp.path, "demo", "summary.md"), "# Demo\nChanged summary.\n");
  expect(fresh()).toBe(false);
});

it("does not adopt another process's fresh sentinel while retaining an old baseline", async () => {
  tmp = makeTempDir("mcp-inputs-peer-");
  const summary = path.join(tmp.path, "demo", "summary.md");
  writeFile(summary, "# Demo\nOld summary.\n");
  const first = await buildIndex(tmp.path);
  const fresh = await captureIndexInputs(tmp.path);
  writeFile(summary, "# Demo\nNew summary.\n");
  const peer = await buildIndex(tmp.path, undefined, { force: true });
  try { expect(fresh()).toBe(false); }
  finally { first.close(); if (first !== peer) peer.close(); }
});

it("refuses to seal a stale fallback during another writer's rebuild", async () => {
  tmp = makeTempDir("mcp-inputs-busy-");
  writeFile(path.join(tmp.path, "demo", "summary.md"), "# Demo\nOld summary.\n");
  const db = await buildIndex(tmp.path);
  const lock = path.join(tmp.path, ".runtime", "index-rebuild.lock");
  writeFile(lock, `${process.pid}\n`);
  try { await expect(buildIndex(tmp.path, undefined, { force: true, requireFresh: true })).rejects.toThrow("busy"); }
  finally { fs.unlinkSync(lock); db.close(); }
  const current = await buildIndex(tmp.path, undefined, { force: true, requireFresh: true });
  current.close();
});

it("recovers a rebuild lock left behind by a process that died mid-rebuild", async () => {
  tmp = makeTempDir("mcp-inputs-dead-");
  writeFile(path.join(tmp.path, "demo", "summary.md"), "# Demo\nSummary.\n");
  const lock = path.join(tmp.path, ".runtime", "index-rebuild.lock");
  // A fresh lock (well inside the 30 s stale window) whose owner is gone.
  const { spawnSync } = await import("node:child_process");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  writeFile(lock, `${dead.stdout}\n${Date.now()}`);
  const db = await buildIndex(tmp.path, undefined, { force: true, requireFresh: true });
  try { expect(fs.existsSync(lock)).toBe(false); }
  finally { db.close(); }
});

it("reports a live owner's lock as a typed busy error", async () => {
  tmp = makeTempDir("mcp-inputs-live-");
  writeFile(path.join(tmp.path, "demo", "summary.md"), "# Demo\nSummary.\n");
  const lock = path.join(tmp.path, ".runtime", "index-rebuild.lock");
  writeFile(lock, `${process.pid}\n${Date.now()}`);
  const { isIndexBusyError } = await import("../shared/index.js");
  try {
    const error = await buildIndex(tmp.path, undefined, { force: true, requireFresh: true }).then(() => null, (e: unknown) => e);
    expect(isIndexBusyError(error)).toBe(true);
  } finally { fs.unlinkSync(lock); }
});
