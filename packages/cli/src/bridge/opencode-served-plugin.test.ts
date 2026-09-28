import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const ps = vi.hoisted(() => ({ command: "" }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: (file: string) => { if (file !== "ps") throw new Error("unexpected"); return `${ps.command}\n`; } }));

type Handler = (input: unknown, output?: Record<string, unknown>) => Promise<void>;
const session = "ses_served1";
let store: string;
beforeEach(async () => {
  store = await mkdtemp(path.join(tmpdir(), "phren-oc-served-"));
  vi.stubEnv("PHREN_PATH", store); vi.stubEnv("PHREN_FANOUT_JOB", "");
  vi.resetModules();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(store, { recursive: true, force: true }); });

async function plugin(): Promise<Record<string, Handler>> {
  const url = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url);
  const { PhrenTranscriptPlugin } = await import(`${url.href}?t=${Date.now()}`) as { PhrenTranscriptPlugin: () => Promise<Record<string, Handler>> };
  return PhrenTranscriptPlugin();
}
const approvals = () => readdir(path.join(store, ".runtime", "approvals")).catch(() => [] as string[]);

it("leaves a permission ask to the Hook when this process serves the port the Hook gave it", async () => {
  vi.stubEnv("PHREN_OPENCODE_PORT", "4567"); vi.stubEnv("OPENCODE_SERVER_PASSWORD", "pw");
  ps.command = "/opt/opencode --model a/b --port 4567";
  const output: Record<string, unknown> = {};
  await (await plugin())["permission.ask"]({ id: "per_1", sessionID: session, type: "bash" }, output);
  expect(output.status).toBe("ask");
  expect(await approvals()).toEqual([]);
});

it("keeps the file ask for an OpenCode started by hand in a served pane's shell", async () => {
  vi.stubEnv("PHREN_OPENCODE_PORT", "4567"); vi.stubEnv("OPENCODE_SERVER_PASSWORD", "pw");
  ps.command = "/opt/opencode";
  const output: Record<string, unknown> = {};
  const asked = (await plugin())["permission.ask"]({ id: "per_2", sessionID: session, type: "bash" }, output);
  const request = path.join(store, ".runtime", "approvals", `opencode-${session}.request.json`);
  for (let i = 0; i < 50 && !(await approvals()).includes(path.basename(request)); i++) await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(path.join(store, ".runtime", "approvals", `opencode-${session}.answer.json`), JSON.stringify({ id: "per_2", decision: "approve" }));
  await asked;
  expect(output.status).toBe("allow");
});
