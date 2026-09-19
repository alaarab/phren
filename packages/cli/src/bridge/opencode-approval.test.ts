import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentHooks } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(),
  validateTarget: vi.fn(async () => ({})),
}));

const session = "ses_f4a6b5c11ffe6nZrRlGZbXXNli";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "opencode", session };
const requestFile = (store: string) => path.join(store, ".runtime", "approvals", `opencode-${session}.request.json`);
const answerFile = (store: string) => path.join(store, ".runtime", "approvals", `opencode-${session}.answer.json`);

describe("opencode file approvals", () => {
  let store: string, previous: string | undefined;
  beforeEach(async () => {
    vi.clearAllMocks();
    store = await mkdtemp(path.join(tmpdir(), "phren-opencode-"));
    previous = process.env.PHREN_PATH;
    process.env.PHREN_PATH = store;
    await mkdir(path.dirname(requestFile(store)), { recursive: true });
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.PHREN_PATH; else process.env.PHREN_PATH = previous;
    await rm(store, { recursive: true, force: true });
  });

  it("surfaces a live opencode request and marks its pane", async () => {
    await writeFile(requestFile(store), JSON.stringify({ id: "per_abc123", sessionID: session, type: "bash",
      title: "Allow bash?", message: "bash: rm -rf /tmp/x", createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    const hooks = new AgentHooks();
    expect(hooks.approval(target)).toMatchObject({ actionId: "per_abc123", toolName: "bash", title: "Allow bash?", message: "bash: rm -rf /tmp/x" });
    const state = { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "opencode",
      agent_session: { kind: "id", agent: "opencode", value: session } }] };
    expect(hooks.pendingPanes("default", state)).toEqual(new Set(["w1:p1"]));
  });

  it("ignores absent, malformed, expired, and unsafe requests", async () => {
    const hooks = new AgentHooks();
    expect(hooks.approval(target)).toBeUndefined();
    await writeFile(requestFile(store), "{ not json");
    expect(hooks.approval(target)).toBeUndefined();
    await writeFile(requestFile(store), JSON.stringify({ id: "per_abc123", sessionID: session, type: "bash",
      expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(hooks.approval(target)).toBeUndefined();
    expect(hooks.approval({ ...target, session: "ses_ok/../escape" })).toBeUndefined();
    expect(hooks.pendingPanes("default", { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1",
      agent: "opencode", agent_session: { kind: "id", agent: "opencode", value: "ses_ok/../escape" } }] })).toEqual(new Set());
  });

  it("answers by writing the answer file atomically", async () => {
    await writeFile(requestFile(store), JSON.stringify({ id: "per_abc123", sessionID: session, type: "bash",
      title: "Allow bash?", message: "bash: rm -rf /tmp/x", expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    const hooks = new AgentHooks();
    await hooks.answer(target, "per_abc123", "approve");
    expect(validateTarget).toHaveBeenCalledWith(target);
    expect(JSON.parse(await readFile(answerFile(store), "utf8"))).toEqual({ id: "per_abc123", decision: "approve" });
    await expect(hooks.answer(target, "per_abc123", "maybe")).rejects.toThrow("not valid");
  });
});
