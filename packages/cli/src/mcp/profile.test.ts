/**
 * The core profile is a promise about what an agent sees: a handful of tools,
 * everything else one call away, and nothing lost. These tests hold the gate
 * to that promise with fake tool modules, so they run without an index.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CORE_TOOLS, buildCompositeTools, createToolGate, dispatch, resolveMcpProfile, schemaWeight, type Catalog, type ToolConfig, type ToolHandler } from "./profile.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] });
const parse = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text);

/** A stand-in for the real modules: the tool names phren registers, with small schemas. */
function fakeModules(register: (name: string, config: ToolConfig, handler: ToolHandler) => void, calls: string[]) {
  const tool = (name: string, description: string, shape: z.ZodRawShape) =>
    register(name, { title: name, description, inputSchema: z.object(shape) }, async (args) => { calls.push(name); return ok({ name, args }); });
  tool("search_knowledge", "Search the store.", { query: z.string(), limit: z.number().optional() });
  tool("get_memory_detail", "Fetch one memory.", { id: z.string() });
  tool("get_project_summary", "Project summary.", { project: z.string() });
  tool("add_finding", "Tell phren an insight. Do it now.", { project: z.string(), finding: z.array(z.string()).min(1), sessionId: z.string().optional() });
  tool("supersede_finding", "Mark a finding superseded.", { project: z.string(), old: z.string(), new: z.string() });
  tool("retract_finding", "Retract a finding.", { project: z.string(), text: z.string() });
  tool("edit_finding", "Edit a finding.", { project: z.string(), id: z.string(), text: z.string() });
  tool("get_tasks", "List tasks.", { project: z.string().optional() });
  tool("add_task", "Add a task.", { project: z.string(), text: z.string() });
  tool("complete_task", "Complete a task.", { project: z.string(), task: z.string() });
  tool("update_task", "Update a task.", { project: z.string(), task: z.string(), text: z.string() });
  tool("session_start", "Start a session.", { project: z.string().optional() });
  tool("session_end", "End a session.", { summary: z.string().optional() });
  tool("list_skills", "List skills. Includes global ones.", { project: z.string().optional() });
  tool("toggle_hooks", "Turn hooks on or off.", { enabled: z.boolean() });
  tool("add_note", "Add a daily note.", { project: z.string(), text: z.string().min(1), date: z.string().optional() });
  tool("get_config", "Read config.", { domain: z.string() });
}

function gateWith(profile: "core" | "full") {
  const registered = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const calls: string[] = [];
  const gate = createToolGate({ profile, register: (n, c, h) => { registered.set(n, { config: c, handler: h }); } });
  fakeModules(gate.registerTool, calls);
  gate.finish();
  return { gate, registered, calls };
}

describe("core profile", () => {
  it("exposes only the core tools, and every one of them", () => {
    const { registered } = gateWith("core");
    expect([...registered.keys()].sort()).toEqual([...CORE_TOOLS].sort());
    for (const name of registered.keys()) expect(registered.get(name)!.config._meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });

  it("keeps everything reachable: the catalog still holds every registered tool", () => {
    const { gate } = gateWith("core");
    expect(gate.catalog.has("toggle_hooks")).toBe(true);
    expect(gate.catalog.has("supersede_finding")).toBe(true);
  });

  it("is a fraction of the weight of the full surface", () => {
    const core = gateWith("core");
    const full = gateWith("full");
    const coreWeight = schemaWeight(core.registered.values());
    const fullWeight = schemaWeight([...full.registered.values()].filter((_, i) => i < full.registered.size));
    expect(coreWeight).toBeLessThan(fullWeight);
    expect(core.registered.size).toBe(CORE_TOOLS.length);
    expect(full.registered.size).toBeGreaterThan(core.registered.size);
  });
});

describe("composites", () => {
  it("revise_finding routes each action to the right tool with the rest of the args", async () => {
    const { registered, calls } = gateWith("core");
    const res = await registered.get("revise_finding")!.handler({ action: "supersede", project: "p", old: "a", new: "b" });
    expect(calls).toEqual(["supersede_finding"]);
    expect(parse(res).data.args).toEqual({ project: "p", old: "a", new: "b" });
  });

  it("validates against the target's own schema and explains a miss", async () => {
    const { registered, calls } = gateWith("core");
    const res = await registered.get("manage_task")!.handler({ action: "complete", project: "p" }); // missing task
    expect(calls).toEqual([]);
    const body = parse(res);
    expect(body.ok).toBe(false);
    expect(body.issues[0].path).toBe("task");
    expect(body.params.map((p: { name: string }) => p.name)).toContain("task");
  });

  it("lists its actions with their required parameters in the description", () => {
    const { registered } = gateWith("core");
    const desc = registered.get("session")!.config.description ?? "";
    expect(desc).toContain("start — Start a session.");
    expect(desc).toContain("end — End a session.");
    const admin = registered.get("phren_admin")!.config.description ?? "";
    expect(admin).toContain("toggle_hooks — Turn hooks on or off. (required: enabled)");
    // Folded tools are not offered twice.
    expect(admin).not.toContain("supersede_finding");
    expect(admin).not.toContain("add_note");
  });

  it("phren_admin runs any non-core tool and can list them all", async () => {
    const { registered, calls } = gateWith("core");
    const listing = parse(await registered.get("phren_admin")!.handler({ action: "list_actions" }));
    expect(listing.actions.map((a: { name: string }) => a.name)).toEqual(["get_config", "list_skills", "toggle_hooks"]);
    await registered.get("phren_admin")!.handler({ action: "toggle_hooks", enabled: false });
    expect(calls).toEqual(["toggle_hooks"]);
  });

  it("add_finding with kind note goes to the note tool", async () => {
    const { registered, calls } = gateWith("core");
    const res = await registered.get("add_finding")!.handler({ project: "p", finding: ["remember this"], kind: "note" });
    expect(calls).toEqual(["add_note"]);
    expect(parse(res).data.args).toEqual({ project: "p", text: "remember this" });
    await registered.get("add_finding")!.handler({ project: "p", finding: ["durable"] });
    expect(calls).toEqual(["add_note", "add_finding"]);
  });

  it("refuses a duplicate registration", () => {
    const gate = createToolGate({ profile: "full", register: () => {} });
    gate.registerTool("x", { description: "" }, async () => ok(null));
    expect(() => gate.registerTool("x", { description: "" }, async () => ok(null))).toThrow(/Duplicate/);
  });
});

describe("full profile", () => {
  it("exposes every tool plus the composites", () => {
    const { registered } = gateWith("full");
    expect(registered.has("toggle_hooks")).toBe(true);
    expect(registered.has("revise_finding")).toBe(true);
    expect(registered.has("phren_admin")).toBe(true);
  });
});

describe("resolveMcpProfile", () => {
  it("env wins, then the install preference, then core", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-profile-"));
    try {
      expect(resolveMcpProfile(dir, {})).toBe("core");
      fs.mkdirSync(path.join(dir, ".runtime"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".runtime", "install-preferences.json"), JSON.stringify({ mcpProfile: "full" }));
      expect(resolveMcpProfile(dir, {})).toBe("full");
      expect(resolveMcpProfile(dir, { PHREN_MCP_PROFILE: "core" })).toBe("core");
      expect(resolveMcpProfile(dir, { PHREN_MCP_PROFILE: "nonsense" })).toBe("full");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatch", () => {
  it("reports an unknown target instead of throwing", async () => {
    const catalog: Catalog = new Map();
    expect(parse(await dispatch(catalog, "nope", {})).error).toMatch(/Unknown tool/);
  });
});
