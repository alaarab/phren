import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupCommand, REGISTRY } from "../cli-registry.js";
import { CORE_TOOLS, createToolGate } from "../mcp/profile.js";
import { VERSION } from "../package-metadata.js";
import { makeTempDir } from "../test-helpers.js";
import { BUILTIN_MODULES, disabledHint, enabled } from "./registry.js";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => { tmp = makeTempDir("modules-test-"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); tmp.cleanup(); });

function configure(text: string): void {
  fs.mkdirSync(path.join(tmp.path, ".config"), { recursive: true });
  fs.writeFileSync(path.join(tmp.path, ".config", "modules.yaml"), text);
}

function names(profile?: string): string[] {
  return enabled(tmp.path, profile).map(module => module.name);
}

describe("module enablement", () => {
  it("points disabled code invocations at the optional package installer", () => {
    expect(disabledHint("code")).toBe("phren code needs @phren/code: run phren modules enable code");
  });
  it("defaults to memory without provisioning files", () => {
    expect(names()).toEqual(["memory"]);
    expect(fs.readdirSync(tmp.path)).toEqual([]);
  });

  it("supports a memory-only store", () => {
    configure("version: 1\nenabled:\n  tasks: false\n");
    expect(names()).toEqual(["memory"]);
  });

  it("overlays the selected store profile on store settings and defaults", () => {
    configure(`version: 1
enabled:
  tasks: false
  hook: true
profiles:
  work:
    enabled:
      tasks: true
      hook: false
  personal:
    enabled:
      git: true
`);
    expect(names()).toEqual(["memory", "hook"]);
    expect(names("work")).toEqual(["memory", "tasks"]);
    expect(names("personal")).toEqual(["memory", "hook", "git"]);
    expect(names("unlisted")).toEqual(["memory", "hook"]);
  });

  it("accepts a version-only config and reads changes on the next call", () => {
    configure("version: 1\n");
    expect(names()).toEqual(["memory"]);
    configure("version: 1\nenabled:\n  tasks: false\n");
    expect(names()).toEqual(["memory"]);
  });

  it("treats a store profile named full as a literal profile name", () => {
    configure("version: 1\nprofiles:\n  full:\n    enabled:\n      tasks: false\n");
    expect(names()).toEqual(["memory"]);
    expect(names("full")).toEqual(["memory"]);
  });

  it.each([
    "", "# empty\n", "null", "[]", "version: [", "version: 2", "enabled: {}",
    "version: 1\nenabled: [tasks]", "version: 1\nenabled:\n  tasks: 'false'",
    "version: 1\nprofiles:\n  work: false", "version: 1\nenabeld: {}",
  ])("rejects malformed configuration instead of falling back to defaults: %s", text => {
    configure(text);
    expect(() => names()).toThrow("Invalid .config/modules.yaml");
  });

  it("reports unreadable config instead of treating it as missing", () => {
    fs.mkdirSync(path.join(tmp.path, ".config", "modules.yaml"), { recursive: true });
    expect(() => names()).toThrow("Cannot read .config/modules.yaml");
  });

  it("ignores unknown module names even in an inactive profile", () => {
    configure("version: 1\nprofiles:\n  work:\n    enabled:\n      code-map: false\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(names()).toEqual(["memory"]);
    expect(error.mock.calls.map(([line]) => String(line)))
      .toContain(`warning: unknown module "code-map" in .config/modules.yaml ignored by Hook ${VERSION}`);
  });

  it.each([
    "version: 1\nenabled:\n  memory: false\n",
    "version: 1\nprofiles:\n  work:\n    enabled:\n      memory: false\n",
  ])("keeps memory required: %s", text => {
    configure(text);
    expect(() => names()).toThrow("The memory module cannot be disabled");
  });

  it("checks dependencies after profile overrides without silently enabling them", () => {
    configure(`version: 1
enabled:
  hook: true
  conductor: true
profiles:
  work:
    enabled:
      hook: false
`);
    expect(names()).toEqual(["memory", "hook", "conductor"]);
    expect(() => names("work")).toThrow('Module "conductor" requires enabled module "hook"');
  });
});

describe("built-in registration declarations", () => {
  const source = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  it("assigns each registered tool and composite exactly one owner", () => {
    const toolsDir = fileURLToPath(new URL("../tools/", import.meta.url));
    const registered = fs.readdirSync(toolsDir).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .flatMap(file => [...fs.readFileSync(path.join(toolsDir, file), "utf8").matchAll(/registerTool\(\s*"([^"]+)"/g)].map(match => match[1]));
    const declared = BUILTIN_MODULES.flatMap(module => module.tools.map(tool => tool.name));
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual([...registered, "revise_finding", "manage_task", "session", "phren_admin"].sort());
    expect(BUILTIN_MODULES.flatMap(module => module.tools.filter(tool => tool.profiles.includes("core")).map(tool => tool.name)).sort())
      .toEqual([...CORE_TOOLS].sort());
    expect(BUILTIN_MODULES.every(module => module.version === VERSION)).toBe(true);
  });

  it("covers CLI entry points, aliases and the shipped skills", () => {
    const commands = BUILTIN_MODULES.flatMap(module => module.cliCommands);
    expect(new Set(commands).size).toBe(commands.length);
    expect([...new Set(commands.map(command => command.split(" ")[0]))].sort())
      .toEqual(REGISTRY.flatMap(command => [command.name, ...(command.aliases ?? [])]).sort());
    const skills = fs.readdirSync(new URL("../../starter/global/skills/", import.meta.url)).sort();
    expect(BUILTIN_MODULES.flatMap(module => module.skills).sort()).toEqual([...skills, "code"].sort());
  });

  it("covers Hook routes with exact methods and no competing owners", () => {
    const declared = BUILTIN_MODULES.flatMap(module => module.hookRoutes);
    const identities = declared.map(route => `${route.method} ${route.path}`);
    expect(new Set(identities).size).toBe(identities.length);
    const server = source("bridge/server-routes.ts");
    const getBlock = server.slice(server.indexOf('if (request.method === "GET")'), server.indexOf('} else if (request.method === "POST")'));
    // The phone's memory routes live in memory-store.ts behind one /v1/store/ prefix check.
    const store = source("bridge/memory-store.ts");
    const storeRoutes = (method: string) => [...store.matchAll(new RegExp(`method === "${method}" && url.pathname === STORE_ROUTES\\.(\\w+)`, "g"))]
      .map(match => `/v1/store/${match[1]}`);
    const currentGets = [...[...getBlock.matchAll(/case "(\/v1\/[^\"]+)"/g)].map(match => match[1]), ...storeRoutes("GET")];
    expect(declared.filter(route => route.method === "GET").map(route => route.path).sort()).toEqual(currentGets.sort());
    const postBlock = server.slice(server.indexOf('} else if (request.method === "POST")'), server.indexOf('} else throw new BridgeError(405'))
      + source("bridge/server-pane-routes.ts");
    const currentPosts = new Set([...postBlock.matchAll(/url.pathname === "(\/v1\/[^\"]+)"/g)].map(match => match[1]));
    for (const operation of ["create", "focus", "rename", "close"]) currentPosts.add(`/v1/workspaces/${operation}`);
    for (const route of storeRoutes("POST")) currentPosts.add(route);
    expect(declared.filter(route => route.method === "POST").map(route => route.path).sort()).toEqual([...currentPosts].sort());
    expect(declared.filter(route => route.method === "WS").map(route => route.path)).toEqual(["/v1/transcripts", "/v1/status", "/v1/overview", "/v1/speech/transcribe"]);
  });

  it("can feed only memory into the existing gate without exposing task or dispatch actions", async () => {
    configure("version: 1\nenabled:\n  tasks: false\n");
    const composites = new Set(["revise_finding", "manage_task", "session", "phren_admin"]);
    const gate = createToolGate({ profile: "core", register: () => {} });
    for (const module of enabled(tmp.path)) {
      for (const tool of module.tools) {
        if (!composites.has(tool.name)) gate.registerTool(tool.name, {}, async () => ({}));
      }
    }
    gate.finish();
    expect([...gate.exposed].sort()).toEqual([
      "search_knowledge", "get_memory_detail", "get_project_summary", "add_finding", "revise_finding", "session", "phren_admin",
    ].sort());
    expect(gate.catalog.has("get_tasks")).toBe(false);
    expect(gate.catalog.has("auto_extract_findings")).toBe(false);
    expect(gate.catalog.has("dispatch")).toBe(false);
    const response = await gate.catalog.get("phren_admin")!.handler({ action: "dispatch" });
    expect(JSON.stringify(response)).toContain("Unknown tool");
  });
});

describe("phren modules list", () => {
  it("lists configured status using the active profile and leaves config untouched", async () => {
    configure("version: 1\nprofiles:\n  work:\n    enabled:\n      tasks: false\n");
    const before = fs.readFileSync(path.join(tmp.path, ".config", "modules.yaml"), "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await lookupCommand("modules")!.run(["list"], { phrenPath: () => tmp.path, profile: () => "work" });
    expect(log).toHaveBeenCalledWith("Module\tVersion\tEffective\tSource\tRequires");
    expect(log).toHaveBeenCalledWith(`memory\t${VERSION}\tenabled\tdefault\t-`);
    expect(log).toHaveBeenCalledWith(`tasks\t${VERSION}\tdisabled\tprofile\tmemory`);
    expect(fs.readFileSync(path.join(tmp.path, ".config", "modules.yaml"), "utf8")).toBe(before);
  });

  it("supports an explicit profile without resolving the machine profile", async () => {
    configure("version: 1\nprofiles:\n  personal:\n    enabled:\n      tasks: false\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const profile = vi.fn(() => "work");
    await lookupCommand("modules")!.run(["list", "--profile", "personal"], { phrenPath: () => tmp.path, profile });
    expect(profile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`tasks\t${VERSION}\tdisabled\tprofile\tmemory`);
  });

  it.each([[], ["enable"], ["disable"], ["list", "extra"], ["list", "--profile"], ["list", "--profile", "--bad"]])
    ("rejects unsupported invocations without touching the store: %j", async (...args: string[]) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const phrenPath = vi.fn(() => tmp.path);
      expect(await lookupCommand("modules")!.run(args, { phrenPath, profile: () => "work" })).toBe(1);
      expect(phrenPath).not.toHaveBeenCalled();
    });
});

describe("phren modules enable", () => {
  it("warns when the installed Hook is older than the module without refusing", async () => {
    configure("version: 1\n");
    const bridge = path.join(tmp.path, "bridge");
    fs.mkdirSync(bridge, { recursive: true });
    fs.writeFileSync(path.join(bridge, "installed.json"), JSON.stringify({ version: "0.0.1" }));
    vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await lookupCommand("modules")!.run(["enable", "git"], { phrenPath: () => tmp.path, profile: () => "work" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("git enabled"));
    expect(names()).toContain("git");
    const warnings = error.mock.calls.map(([line]) => String(line));
    expect(warnings.some(line => line.includes("installed Phren Hook 0.0.1 is older than module git") && line.includes(VERSION))).toBe(true);
  });

  it("stays quiet when no Hook is installed", async () => {
    configure("version: 1\n");
    const bridge = path.join(tmp.path, "empty-bridge");
    fs.mkdirSync(bridge, { recursive: true });
    vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await lookupCommand("modules")!.run(["enable", "git"], { phrenPath: () => tmp.path, profile: () => "work" });
    expect(names()).toContain("git");
    expect(error).not.toHaveBeenCalled();
  });
});
