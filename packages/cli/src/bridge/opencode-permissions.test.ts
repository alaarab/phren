import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowOpencodeToolEverywhere, opencodeToolName, withAllowedTool } from "./opencode-permissions.js";

describe("the OpenCode allow-everywhere rule", () => {
  let root: string, file: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-oc-config-")); file = path.join(root, "opencode", "opencode.json"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("adds the tool to a missing permission block and keeps every other key", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "a/b" }));
    await allowOpencodeToolEverywhere("bash", file);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json", model: "a/b", permission: { bash: "allow" } });
  });

  it("keeps other tools and turns a whole-block string into its wildcard entry", () => {
    expect(withAllowedTool({ permission: { edit: "deny", bash: "ask" } }, "bash"))
      .toEqual({ permission: { edit: "deny", bash: "allow" } });
    expect(withAllowedTool({ permission: "ask" }, "bash"))
      .toEqual({ permission: { "*": "ask", bash: "allow" } });
  });

  it("keeps a granular rule's patterns, with the allow as the wildcard", () => {
    expect(withAllowedTool({ permission: { bash: { "git *": "allow", "rm *": "deny" } } }, "bash"))
      .toEqual({ permission: { bash: { "*": "allow", "git *": "allow", "rm *": "deny" } } });
    expect(withAllowedTool({ permission: { bash: { "*": "ask", "git *": "allow" } } }, "bash"))
      .toEqual({ permission: { bash: { "*": "allow", "git *": "allow" } } });
  });

  it("takes only OpenCode's own tool names", () => {
    expect(opencodeToolName("external_directory")).toBe("external_directory");
    expect(opencodeToolName(" bash ")).toBe("bash");
    expect(opencodeToolName("../escape")).toBeUndefined();
    expect(opencodeToolName("")).toBeUndefined();
  });

  it("refuses a config that is not a JSON object, leaving it untouched", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "[1, 2, 3]");
    await expect(allowOpencodeToolEverywhere("bash", file)).rejects.toThrow("not a JSON object");
    expect(await readFile(file, "utf8")).toBe("[1, 2, 3]");
  });
});
