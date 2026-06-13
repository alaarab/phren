import { describe, expect, it } from "vitest";
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
import type { McpContext } from "../tools/types.js";

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

describe("MCP tool registration", () => {
  it("registers no duplicate tool names across all modules", () => {
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

    const duplicates = server.names.filter((name, i) => server.names.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
    expect(server.names.length).toBeGreaterThan(0);
  });
});
