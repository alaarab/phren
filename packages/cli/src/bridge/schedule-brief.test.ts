import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { servers, snapshot } from "./herdr.js";
import { createScheduleLauncher } from "./schedule-launch.js";
import type { Schedule } from "./schedule-format.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import type { Json } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), servers: vi.fn(), snapshot: vi.fn(), paneIdentity: vi.fn(async () => undefined),
}));

const schedule = { id: "7f3a2c1d", name: "Nightly sweep", harness: "codex", prompt: "Run the test suite." } as Schedule;
const runId = "50000000-0000-4000-8000-000000000001";
let typed: string[], restore: () => void;
beforeEach(() => {
  typed = [];
  vi.mocked(servers).mockResolvedValue([{ session: "default" }]);
  vi.mocked(snapshot).mockResolvedValue({ panes: [] });
  restore = setTerminalProvider({ prompt: async (_server: string, _pane: string, text: string) => { typed.push(text); } } as unknown as TerminalProvider);
});
afterEach(() => { restore(); vi.resetAllMocks(); });

async function run(launched: Json): Promise<Json[]> {
  const calls: Json[] = [];
  const launcher = createScheduleLauncher(async (_server, data) => { calls.push(data); return { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", ...launched }; }, "/tmp/store");
  await launcher({ schedule, cwd: "/work/app", runId, project: "demo" } as never);
  launcher.close?.();
  return calls;
}

// Harness audit §4.1: a scheduled run's prompt goes with the launch like a dispatch brief.
it("offers the prompt with the launch and types nothing when the harness took it", async () => {
  const calls = await run({ briefLaunched: true });
  expect(calls[0]).toMatchObject({ kind: "codex", brief: { id: runId, text: "Run the test suite." } });
  expect(typed).toEqual([]);
});

it("types the prompt when the launch could not carry it", async () => {
  await run({ briefLaunched: false });
  expect(typed).toEqual(["Run the test suite."]);
});
