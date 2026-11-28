/** set_config's retention budgets as an agent reaches them: invalid values are refused and change nothing. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { createToolGate, type ToolConfig, type ToolHandler } from "../mcp/profile.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { clearProjectConfigCache, readProjectConfig } from "../project-config.js";
import { getRetentionPolicy } from "../governance/policy.js";
import type { McpContext } from "./types.js";
import { register as registerConfig } from "./config.js";

const parse = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text);

let store: { path: string; cleanup: () => void };
beforeEach(() => {
  store = makeTempDir("phren-config-budgets-");
  fs.mkdirSync(path.join(store.path, "demo"), { recursive: true });
  clearProjectConfigCache();
});
afterEach(() => store.cleanup());

function admin() {
  const exposed = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const gate = createToolGate({ profile: "core", modules: BUILTIN_MODULES, register: (name, config, handler) => { exposed.set(name, { config, handler }); } });
  const ctx = { phrenPath: store.path, profile: "", rebuildIndex: async () => {}, updateFileInIndex: () => {},
    db: () => { throw new Error("no index"); }, withWriteQueue: async <T>(fn: () => Promise<T>) => fn() } as unknown as McpContext;
  registerConfig({ registerTool: gate.registerTool } as never, ctx);
  gate.finish();
  return async (args: Record<string, unknown>) => parse(await exposed.get("phren_admin")!.handler({ action: "set_config", domain: "retention", ...args }));
}

describe("set_config retention budgets", () => {
  it.each([
    [{ budgets: { reviewEntries: "0" } }, "budgets.reviewEntries"],
    [{ budgets: { reviewEntries: -3 } }, "budgets.reviewEntries"],
    [{ budgets: { runtimeAgeOut: "yes" } }, "budgets.runtimeAgeOut"],
    [{ budgets: { runtimeAgeOutDays: 1 } }, "budgets.runtimeAgeOutDays"],
    [{ budgets: "lots" }, "budgets"],
  ])("refuses %j and leaves the policy unchanged", async (settings, named) => {
    const call = admin();
    expect(await call({ settings: { budgets: { reviewEntries: 90 } } })).toMatchObject({ ok: true });
    const refused = await call({ settings });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(named);
    expect(getRetentionPolicy(store.path).budgets.reviewEntries).toBe(90);
  });

  it("refuses a computer-wide budget for one project and stores a project's review budget", async () => {
    const call = admin();
    expect((await call({ project: "demo", settings: { budgets: { runtimeMB: 10 } } })).ok).toBe(false);
    expect(await call({ project: "demo", settings: { budgets: { reviewEntries: 0 } } })).toMatchObject({ ok: true });
    expect(readProjectConfig(store.path, "demo").config?.retentionPolicy?.budgets).toEqual({ reviewEntries: 0 });
  });
});
