import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function plugin(input?: unknown): Promise<Record<string, Handler>> {
  const url = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url);
  const { PhrenTranscriptPlugin } = await import(`${url.href}?t=${Date.now()}`) as { PhrenTranscriptPlugin: (input?: unknown) => Promise<Record<string, Handler>> };
  return PhrenTranscriptPlugin(input);
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

// OpenCode 1.18.31 never calls the permission.ask hook; the TUI draws the ask
// from its `permission.asked` event, shaped as below.
const asked = (id: string) => ({ event: { type: "permission.asked", properties: { id, sessionID: session, permission: "bash",
  patterns: ["echo probe-ok"], metadata: { command: "echo probe-ok" }, always: ["echo *"] } } });
const requestFile = () => path.join(store, ".runtime", "approvals", `opencode-${session}.request.json`);
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise(resolve => setTimeout(resolve, 20));
}

it("relays an OpenCode 1.18 ask from its event and replies with the phone's answer through the process's API", async () => {
  ps.command = "/opt/opencode";
  const reply = vi.fn(async () => ({ data: true }));
  const handlers = await plugin({ client: { postSessionIdPermissionsPermissionId: reply } });
  await handlers.event(asked("per_3"));
  await until(async () => (await approvals()).includes(path.basename(requestFile())));
  const request = JSON.parse(await readFile(requestFile(), "utf8"));
  expect(request).toMatchObject({ id: "per_3", sessionID: session, type: "bash", title: "Allow bash?", message: "bash: echo probe-ok" });
  expect(Date.parse(request.expiresAt) - Date.parse(request.createdAt)).toBe(30 * 60_000);
  await writeFile(path.join(store, ".runtime", "approvals", `opencode-${session}.answer.json`), JSON.stringify({ id: "per_3", decision: "deny" }));
  await until(() => reply.mock.calls.length > 0);
  expect(reply).toHaveBeenCalledWith({ path: { id: session, permissionID: "per_3" }, body: { response: "reject" } });
  await until(async () => (await approvals()).length === 0);
  expect(await approvals()).toEqual([]);
});

it("withdraws a relayed ask the terminal answered first", async () => {
  ps.command = "/opt/opencode";
  const reply = vi.fn(async () => ({ data: true }));
  const handlers = await plugin({ client: { postSessionIdPermissionsPermissionId: reply } });
  await handlers.event(asked("per_4"));
  await until(async () => (await approvals()).length === 1);
  await handlers.event({ event: { type: "permission.replied", properties: { sessionID: session, requestID: "per_4", reply: "once" } } });
  await until(async () => (await approvals()).length === 0);
  expect(await approvals()).toEqual([]);
  expect(reply).not.toHaveBeenCalled();
});

it("relays nothing from the event for a process the Hook serves", async () => {
  const reply = vi.fn(async () => ({ data: true }));
  vi.stubEnv("PHREN_OPENCODE_PORT", "4567"); vi.stubEnv("OPENCODE_SERVER_PASSWORD", "pw");
  ps.command = "/opt/opencode --port 4567";
  const served = await plugin({ client: { postSessionIdPermissionsPermissionId: reply } });
  await served.event(asked("per_5"));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await approvals()).toEqual([]);
});
