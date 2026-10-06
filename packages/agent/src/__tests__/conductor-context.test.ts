import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConductorContext, setHerdrHookSession, askHerdrPermission } from "../herdr-hooks.js";
import { ToolRegistry } from "../tools/registry.js";
import { runTurn, createSession } from "../agent-loop/index.js";
import type { LlmProvider } from "../providers/types.js";

vi.mock("../spinner.js", () => ({ createSpinner: () => ({ start() {}, update() {}, stop() {} }), formatTurnHeader: () => "" }));
vi.mock("../tools/lint-test.js", () => ({ detectLintCommand: () => null, detectTestCommand: () => null }));

let home: string | undefined, server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  setHerdrHookSession(null);
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});
function setup() {
  home = mkdtempSync(path.join(tmpdir(), "agent-conductor-"));
  mkdirSync(path.join(home, "current"));
  writeFileSync(path.join(home, "current/bridge-hook.mjs"), "// lifecycle fixture\n");
  vi.stubEnv("PHREN_BRIDGE_HOME", home);
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1");
  return home;
}

// The transport and prompt consumption are real; only the remote Hook reply
// and paid model are fakes. Hook-side identity checks live in its socket suite.
describe.skipIf(process.platform === "win32")("root conductor context", () => {
  it("refreshes the system context each turn without persisting or leaking it to another session", async () => {
    const root = setup(), session = createSession();
    setHerdrHookSession(session.log.header.sessionId);
    let context: string | undefined = "Phren role for this turn: conductor. Use dispatch and hand_off.";
    const requests: unknown[] = [];
    server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, ...JSON.parse(body) });
      res.end(JSON.stringify(context ? { context } : {}));
    });
    await new Promise<void>(resolve => server!.listen(path.join(root, "agent.sock"), resolve));
    const prompts: string[] = [];
    const provider: LlmProvider = { name: "fake", async chat(system) {
      prompts.push(system); return { content: [{ type: "text", text: "ready" }], stop_reason: "end_turn" };
    } };
    const config = { provider, registry: new ToolRegistry(), systemPrompt: "base", turnContext: readConductorContext, maxTurns: 1, verbose: false };
    const quiet = { onStatus() {}, onTextDelta() {}, onTextBlock() {} };
    await runTurn("status", session, config, quiet);
    expect(prompts[0]).toContain("Use dispatch and hand_off");
    expect(JSON.stringify(session.messages)).not.toContain("role for this turn");
    expect(requests).toEqual([{ path: "/conductor-context", pid: process.pid, session: session.log.header.sessionId }]);
    expect(await readConductorContext("child-session")).toBeUndefined();
    expect(requests).toHaveLength(1);
    context = undefined;
    await runTurn("status again", session, config, quiet);
    expect(prompts[1]).toBe("base");
  });

  it.each(["allow", "deny", "unavailable"])("uses a Hook %s decision with terminal fallback only when unavailable", async decision => {
    const root = setup(); setHerdrHookSession("aaaaaaaa-1111-4111-8111-111111111111");
    writeFileSync(path.join(root, "current/bridge-hook.mjs"), `let text = ''; for await (const c of process.stdin) text += c; const p = JSON.parse(text);
      if (p.hook_event_name !== 'PermissionRequest' || p.tool_name !== 'mcp_phren_phren_admin') process.exit(1);
      console.log(JSON.stringify(${JSON.stringify(decision === "unavailable" ? {} : { hookSpecificOutput: { decision: { behavior: decision } } })}));`);
    const registry = new ToolRegistry();
    registry.externalApproval = askHerdrPermission;
    registry.askUser = vi.fn(async () => false);
    const execute = vi.fn(async () => ({ output: "dispatched" }));
    registry.register({ name: "mcp_phren_phren_admin", description: "Phren", input_schema: {}, execute });
    const result = await registry.execute("mcp_phren_phren_admin", { action: "dispatch" });
    expect(execute).toHaveBeenCalledTimes(decision === "allow" ? 1 : 0);
    expect(registry.askUser).toHaveBeenCalledTimes(decision === "unavailable" ? 1 : 0);
    expect(result.is_error ?? false).toBe(decision !== "allow");
  });
});
