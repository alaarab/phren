import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchHeadless } from "./dispatch-headless.js";

const dispatchId = "aaaaaaaa-1111-4111-8111-111111111111";
const parent = { provider: "codex", session: "bbbbbbbb-2222-4222-8222-222222222222", computer: "cccccccc-3333-4333-8333-333333333333" };

function fakeChild() {
  const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
  child.stdin = new PassThrough(); child.unref = vi.fn();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

describe("headless dispatch receiver", () => {
  let root: string, source: string, wrapper: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-headless-"));
    source = path.join(root, "source"); wrapper = path.join(root, "run.sh");
    await mkdir(source); await writeFile(wrapper, "#!/bin/sh\n"); await chmod(wrapper, 0o700);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function service(overrides: Partial<ConstructorParameters<typeof DispatchHeadless>[0]> = {}) {
    return new DispatchHeadless({ root, wrapperPath: wrapper, spawn: vi.fn(() => fakeChild()),
      createWorktree: async (_source, worktree) => { await mkdir(worktree, { recursive: true }); return worktree; }, ...overrides });
  }
  const brief = { dispatchId, parent, harness: "codex" as const, model: "gpt-6-astra", mode: "workspace-write" as const,
    label: "Parser checks", prompt: "Run the assigned checks." };
  const spawned = (_file: string, _args: readonly string[], _options: SpawnOptions) => fakeChild();

  it("requires the locally installed wrapper and only accepts supported headless providers", async () => {
    await rm(wrapper);
    await expect(service().launch(brief, source)).rejects.toMatchObject({ status: 503 });
    await writeFile(wrapper, "#!/bin/sh\n"); await chmod(wrapper, 0o700);
    await expect(service().launch({ ...brief, harness: "claude" }, source)).rejects.toThrow();
  });

  it("passes validated wrapper argv without a shell and gives it an isolated worktree", async () => {
    const spawn = vi.fn(spawned);
    const launched = await service({ spawn }).launch({ ...brief, label: "Quotes; stay text", model: "gpt;not-a-command" }, source);
    const [, args, options] = spawn.mock.calls[0];
    expect(args).toEqual(["--provider", "codex", "--label", "Quotes; stay text", "--worktree", expect.any(String),
      "--model", "gpt;not-a-command", "--mode", "workspace-write"]);
    expect(options).toMatchObject({ cwd: args[5], detached: true });
    expect(options.shell).toBeUndefined();
    expect(args[5]).not.toBe(source);
    expect(launched).toMatchObject({ ok: true, destination: { kind: "headless" }, provider: "codex" });
    await expect(service().launch({ ...brief, model: "--mode" }, source)).rejects.toThrow();
  });

  it("persists parent identity and the dispatch id before the wrapper can run", async () => {
    const launched = await service().launch(brief, source);
    const jobId = String((launched.destination as { jobId: string }).jobId);
    const manifest = JSON.parse(await readFile(path.join(root, "headless-dispatches", jobId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, jobId, dispatchId, parent, provider: "codex", status: "running" });
    expect(JSON.stringify(launched)).not.toContain(source);
  });

  it("leaves a spawned-but-unrecorded worker uncertain and never restarts it", async () => {
    const spawn = vi.fn(spawned);
    const interrupted = service({ spawn, maxLeads: 1, afterSpawn: () => { throw new Error("crash after spawn"); } });
    await expect(interrupted.launch(brief, source)).rejects.toMatchObject({ status: 503 });
    expect(spawn).toHaveBeenCalledTimes(1);
    const dirs = await import("node:fs/promises").then(fs => fs.readdir(path.join(root, "headless-dispatches")));
    const jobId = dirs[0];
    expect(await new DispatchHeadless({ root, wrapperPath: wrapper, maxLeads: 1 }).read({ destination: { kind: "headless", jobId } }))
      .toMatchObject({ status: "uncertain" });
    await expect(service({ spawn, maxLeads: 1 }).launch({ ...brief, dispatchId: "dddddddd-4444-4444-8444-444444444444" }, source)).rejects.toMatchObject({ status: 429 });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("bounds durable leads while an originating connection is gone", async () => {
    const spawn = vi.fn(spawned);
    const receiver = service({ spawn, maxLeads: 1 });
    await receiver.launch(brief, source);
    expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true });
    await expect(receiver.launch({ ...brief, dispatchId: "eeeeeeee-5555-4555-8555-555555555555" }, source)).rejects.toMatchObject({ status: 429 });
  });
});
