import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { register as registerSearch } from "../tools/search.js";
import { register as registerTask } from "../tools/tasks.js";
import { register as registerFinding } from "../tools/finding.js";
import { register as registerMemory } from "../tools/memory.js";
import { register as registerData } from "../tools/data.js";
import { register as registerGraph } from "../tools/graph.js";
import { register as registerSession } from "../tools/session.js";
import { register as registerOps } from "../tools/ops.js";
import { register as registerSkills } from "../tools/skills.js";
import { register as registerHooks } from "../tools/hooks.js";
import { register as registerExtract } from "../tools/extract.js";
import { register as registerConfig } from "../tools/config.js";
import { register as registerNotes } from "../tools/notes.js";
import type { McpContext } from "../tools/types.js";

// NOTE: this must list every module index.ts registers with the live MCP
// server. `notes` was missing here until the docs-count guard test below
// caught it (docs/api-reference.md said 59 tools; this array only exercised
// 54) — its 5 tools were never covered by the duplicate-name check.
const ALL_REGISTER_FNS = [
  registerSearch,
  registerTask,
  registerFinding,
  registerMemory,
  registerData,
  registerGraph,
  registerSession,
  registerOps,
  registerSkills,
  registerHooks,
  registerExtract,
  registerConfig,
  registerNotes,
];

function makeRecordingServer() {
  const names: string[] = [];
  return {
    names,
    registerTool(name: string, _meta: unknown, _handler: unknown) {
      names.push(name);
    },
  };
}

/** Registers every tool module against a recording server and returns the tool names. */
function registerAllTools(): string[] {
  const server = makeRecordingServer();
  const ctx: McpContext = {
    phrenPath: "/nonexistent",
    profile: "test",
    db: () => { throw new Error("not needed at registration time"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };

  for (const register of ALL_REGISTER_FNS) {
    register(server as any, ctx);
  }
  return server.names;
}

describe("MCP tool registration", () => {
  it("registers no duplicate tool names across all modules", () => {
    const names = registerAllTools();
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
    expect(names.length).toBeGreaterThan(0);
  });

  // Guards against the doc-rot pattern where a tool is added/removed but the
  // headline count in docs/api-reference.md ("Phren exposes N MCP tools across
  // M modules") is never updated — that sentence once said 54 when the real
  // count was 59, and nothing failed. If this fails, either update the
  // sentence at the top of docs/api-reference.md to match the new counts, or
  // (if the sentence is already right) fix ALL_REGISTER_FNS above: it was
  // missing `notes` for a while, silently under-counting by 5.
  it("keeps docs/api-reference.md's tool/module counts in sync with actual registrations", () => {
    const names = registerAllTools();

    const apiReferencePath = path.resolve(__dirname, "..", "..", "..", "..", "docs", "api-reference.md");
    const apiReference = fs.readFileSync(apiReferencePath, "utf8");
    const match = apiReference.match(/Phren exposes (\d+) MCP tools across (\d+) modules/);
    expect(match, "expected docs/api-reference.md to contain the 'Phren exposes N MCP tools across M modules' sentence").not.toBeNull();

    const [, documentedToolCount, documentedModuleCount] = match!;
    expect(names.length).toBe(Number(documentedToolCount));
    expect(ALL_REGISTER_FNS.length).toBe(Number(documentedModuleCount));
  });
});
