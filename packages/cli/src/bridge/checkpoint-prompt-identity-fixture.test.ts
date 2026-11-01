import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ids = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: (() => `c0000000-0000-4000-8000-${String(++ids.n).padStart(12, "0")}`) as typeof actual.randomUUID };
});

const pane = vi.hoisted(() => ({ cwd: "", foreground_cwd: "", terminal_id: "term-conformance", agent_status: "idle" }));
vi.mock("./herdr.js", async original => ({ ...await original<object>(), validateTarget: vi.fn(async () => ({ ...pane })) }));
vi.mock("./schedule-watch.js", async original => ({ ...await original<object>(), readFinalTurn: vi.fn(async () => undefined) }));
vi.mock("./transcripts.js", async original => ({ ...await original<object>(), childAgentTree: vi.fn(async () => []) }));

import { checkpointBoundary, checkpointRoute, type CheckpointRow } from "./checkpoints.js";
import { claudePromptEntryId } from "./prompt-identity.js";
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
import type { Target } from "./protocol.js";

const exec = promisify(execFile);
let base = "";

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".scratch"), { recursive: true });
  base = await realpath(await mkdtemp(path.join(process.cwd(), ".scratch/checkpoint-conformance-")));
  vi.stubEnv("PHREN_BRIDGE_HOME", base);
  vi.stubEnv("PHREN_PATH", path.join(base, "store"));
  await mkdir(path.join(base, "store"), { recursive: true });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (base) await rm(base, { recursive: true, force: true });
  base = "";
});

async function worktree() {
  const root = path.join(base, "repo"), worker = path.join(base, "worker");
  const env = { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  // Raw fixture operations delete the same long ref lock paths as the Hook.
  // This process-local option leaves the repo config unchanged, so capture
  // still independently exercises the Hook's own long-path handling.
  const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "core.longpaths=true", "-C", cwd, ...args], { env })).stdout;
  await exec("git", ["init", "-q", "-b", "main", root], { env });
  await writeFile(path.join(root, "file.txt"), "base\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");
  await git(root, "worktree", "add", "-qb", "feature", worker);
  pane.cwd = pane.foreground_cwd = worker;
  return { worker, git };
}

it("produces exactly the conformance fixture's checkpoint list and prompt mapping", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../fixtures/conformance/checkpoint-prompt-identity.json", import.meta.url), "utf8")) as {
    session: string;
    rows: { promptId?: string; message: { content: string } }[];
    checkpoints: CheckpointRow[];
    expectedCheckpointIdByPromptEntryId: Record<string, string>;
  };
  const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: fixture.session };
  const { worker, git } = await worktree();
  const [alpha, , , beta, gamma] = fixture.rows;
  const alphaId = claudePromptEntryId(alpha.promptId)!, betaId = claudePromptEntryId(beta.promptId)!, gammaId = claudePromptEntryId(gamma.promptId)!;
  const alphaCheckpoint = fixture.checkpoints.find(row => row.promptEntryId === alphaId)!;
  const betaCheckpoint = fixture.checkpoints.find(row => row.promptEntryId === betaId)!;
  const stopCheckpoint = fixture.checkpoints.find(row => row.boundary === "stop")!;
  const recoveryCheckpoint = fixture.checkpoints.find(row => row.boundary === "recovery")!;
  const readPane = async () => ({ agent_status: "idle" });
  const settled = () => checkpointRoute(worker, target, "list", {}, readPane);

  vi.useFakeTimers({ toFake: ["Date"] });
  ids.n = 0;
  const at = (time: string) => vi.setSystemTime(Date.parse(time));
  at(alphaCheckpoint.at);
  await writeFile(path.join(worker, "file.txt"), "alpha\n");
  checkpointBoundary(worker, target, "UserPromptSubmit", 1, alpha.message.content, alphaId);
  await settled();
  at(stopCheckpoint.at);
  await writeFile(path.join(worker, "file.txt"), "stop\n");
  checkpointBoundary(worker, target, "Stop", 2, "");
  await settled();
  at(betaCheckpoint.at);
  await writeFile(path.join(worker, "file.txt"), "beta\n");
  checkpointBoundary(worker, target, "UserPromptSubmit", 3, beta.message.content, betaId);
  await settled();
  at(new Date(Date.parse(betaCheckpoint.at) + 1_000).toISOString());
  await writeFile(path.join(worker, "file.txt"), "gamma\n");
  checkpointBoundary(worker, target, "UserPromptSubmit", 4, gamma.message.content, gammaId);
  await settled();

  // The gamma prompt's own checkpoint is pruned, while its transcript entry
  // keeps the identity.
  const captured = await checkpointRoute(worker, target, "list", {}, readPane) as { checkpoints: CheckpointRow[]; skippedCaptures: unknown[] };
  expect(captured.skippedCaptures).toEqual([]);
  const gammaRow = captured.checkpoints.find(row => row.promptEntryId === gammaId)!;
  const gammaRef = (await git(worker, "for-each-ref", "--format=%(refname)", "refs/phren/checkpoints/")).trim().split("\n")
    .find(ref => ref.endsWith(gammaRow.id))!;
  await git(worker, "update-ref", "-d", gammaRef);

  // A production restore writes the recovery row that the list carries.
  at(recoveryCheckpoint.at);
  const preview = await checkpointRoute(worker, target, "preview", { checkpointId: alphaCheckpoint.id }, readPane) as { token: string };
  await checkpointRoute(worker, target, "restore", { checkpointId: alphaCheckpoint.id, token: preview.token }, readPane);

  const listed = await paneRoute({} as PaneRouteContext, new URL("http://localhost/v1/git/checkpoints"),
    { target, expectedRepository: worker }, {} as ServerResponse) as { checkpoints: CheckpointRow[] };
  expect(listed.checkpoints).toEqual(fixture.checkpoints);
  expect(Object.fromEntries(listed.checkpoints.filter(row => row.boundary === "prompt" && row.promptEntryId)
    .map(row => [row.promptEntryId!, row.id]))).toEqual(fixture.expectedCheckpointIdByPromptEntryId);
  expect(listed.checkpoints.some(row => row.promptEntryId === gammaId)).toBe(false);
}, 30_000);
