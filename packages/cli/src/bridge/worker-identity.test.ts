import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLaunchLock, launchInProgress, markSubmitted, processStartTime, releaseLaunchLock, setWorkerProcessScan, workerAlive, workerFilePath } from "./worker-identity.js";

const id = "60000000-0000-4000-8000-000000000001";

describe("keyed worker identity", () => {
  let root: string;
  const children: ChildProcess[] = [];
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-worker-"));
    vi.stubEnv("PHREN_BRIDGE_HOME", root);
    setWorkerProcessScan(async () => ({ ok: true }));
    await mkdir(path.join(root, "clones"), { recursive: true });
  });
  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.length = 0;
    setWorkerProcessScan(undefined);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const child = async (env: NodeJS.ProcessEnv = {}) => {
    const spawned = spawn("sleep", ["30"], { stdio: "ignore", env: { ...process.env, ...env } });
    children.push(spawned);
    return { pid: spawned.pid!, start: (await processStartTime(spawned.pid!))! };
  };

  it("tracks a real child process, then reports it gone and rejects a reused PID", async () => {
    const worker = await child();
    await writeFile(workerFilePath(id), `${worker.pid} ${worker.start}\n`, { mode: 0o600 });
    expect(await workerAlive(id)).toBe("alive");
    children[0].kill("SIGKILL");
    await new Promise<void>(resolve => children[0].once("exit", () => resolve()));
    expect(await workerAlive(id)).toBe("gone");
    // The same PID with another process's start time is a reused PID, not our worker.
    await writeFile(workerFilePath(id), `${process.pid} Thu Jan  1 00:00:00 1970\n`, { mode: 0o600 });
    expect(await workerAlive(id)).toBe("gone");
  });

  it("is unknown while a live launch lock is held, and ignores a stale one", async () => {
    const lock = await acquireLaunchLock(id);
    expect(await launchInProgress(id)).toBe(true);
    expect(await workerAlive(id)).toBe("unknown");
    await releaseLaunchLock(lock);
    expect(await launchInProgress(id)).toBe(false);
    expect(await workerAlive(id)).toBe("gone");
    await writeFile(path.join(root, "clones", `${id}.launching`), JSON.stringify({ pid: 999999, start: "gone", nonce: "stale" }), { mode: 0o600 });
    expect(await launchInProgress(id)).toBe(false);
  });

  it("is unknown for an unreadable identity file", async () => {
    await writeFile(workerFilePath(id), "not a pid\n", { mode: 0o600 });
    expect(await workerAlive(id)).toBe("unknown");
  });

  it("finds a submitted launch by its process environment and adopts it", async () => {
    await markSubmitted(id);
    const worker = await child({ PHREN_WORKER_ID_FILE: workerFilePath(id) });
    setWorkerProcessScan(async () => ({ ok: true, worker: { pid: worker.pid, start: worker.start } }));
    expect(await workerAlive(id)).toBe("alive");
    expect(await readFile(workerFilePath(id), "utf8")).toContain(`${worker.pid} `);
    children[0].kill("SIGKILL");
    await new Promise<void>(resolve => children[0].once("exit", () => resolve()));
    expect(await workerAlive(id)).toBe("gone");
  });

  it("is gone after a long-submitted launch with no matching process, and unknown while recent", async () => {
    await markSubmitted(id, new Date(Date.now() - 130_000));
    expect(await workerAlive(id)).toBe("gone");
    await markSubmitted(id);
    expect(await workerAlive(id)).toBe("unknown");
  });

  it("is unknown when the process scan itself fails", async () => {
    setWorkerProcessScan(async () => ({ ok: false }));
    expect(await workerAlive(id)).toBe("unknown");
  });
});
