import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emitHerdrHook, herdrHookBundle, setHerdrHookSession } from "../herdr-hooks.js";

const session = "aaaaaaaa-1111-4111-8111-111111111111";

function bridgeHome(withBundle: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phren-bridge-"));
  if (withBundle) {
    fs.mkdirSync(path.join(root, "current"), { recursive: true });
    fs.writeFileSync(path.join(root, "current/bridge-hook.mjs"), "// fixture bundle\n");
  }
  return root;
}

describe("Herdr lifecycle hooks", () => {
  it("stays silent outside Herdr, without a pane, or without an installed bundle", () => {
    const home = bridgeHome(true);
    const calls: string[][] = [];
    const runner = (_: string, args: string[]) => { calls.push(args); };
    expect(herdrHookBundle({ PHREN_BRIDGE_HOME: home })).toBeNull();
    expect(herdrHookBundle({ HERDR_ENV: "1", PHREN_BRIDGE_HOME: home })).toBeNull();
    expect(emitHerdrHook("SessionStart", { sessionId: session, env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PHREN_BRIDGE_HOME: bridgeHome(false) }, runner })).toBeNull();
    expect(emitHerdrHook("SessionStart", { sessionId: null, env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PHREN_BRIDGE_HOME: home }, runner })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("calls the bundle's phren hook with the same JSON the other agents' hooks send", () => {
    const home = bridgeHome(true);
    const calls: { command: string; args: string[]; stdin: string }[] = [];
    const runner = (command: string, args: string[], stdin: string) => { calls.push({ command, args, stdin }); };
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PHREN_BRIDGE_HOME: home };
    setHerdrHookSession(session);
    try {
      const sent = emitHerdrHook("UserPromptSubmit", { env, runner, cwd: "/work/app" });
      expect(sent).toEqual({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: "/work/app" });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(process.execPath);
      expect(calls[0].args).toEqual([path.join(home, "current/bridge-hook.mjs"), "hook", "phren"]);
      expect(JSON.parse(calls[0].stdin)).toEqual(sent);
    } finally {
      setHerdrHookSession(null);
    }
  });

  it("never lets a failing runner reach the caller", () => {
    const home = bridgeHome(true);
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PHREN_BRIDGE_HOME: home };
    expect(emitHerdrHook("Stop", { sessionId: session, env, runner: () => { throw new Error("spawn failed"); } })).toBeNull();
  });
});
