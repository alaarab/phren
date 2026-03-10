import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import type { McpContext } from "../mcp-types.js";

vi.mock("../shared-ollama.js", () => ({
  checkOllamaAvailable: vi.fn(async () => true),
  checkModelAvailable: vi.fn(async () => true),
  generateText: vi.fn(async () => '["[pattern] Retry socket setup after ECONNRESET"]'),
  getOllamaUrl: vi.fn(() => "http://localhost:11434"),
  getExtractModel: vi.fn(() => "llama3.2"),
}));

vi.mock("../shared-content.js", () => ({
  addFindingsToFile: vi.fn(() => ({
    ok: true,
    data: {
      added: ["[pattern] Retry socket setup after ECONNRESET"],
      skipped: [],
      rejected: [],
    },
  })),
}));

import { register } from "../mcp-extract.js";
import { addFindingsToFile } from "../shared-content.js";
import { generateText } from "../shared-ollama.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("mcp-extract proactivity gating", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-extract-proactivity-");
    grantAdmin(tmp.path);
    fs.mkdirSync(path.join(tmp.path, "demo"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "demo", "summary.md"), "# demo\n");
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => { throw new Error("db not expected"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };

    register(server as any, ctx);
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_FINDINGS;
    vi.mocked(addFindingsToFile).mockClear();
    vi.mocked(generateText).mockClear();
  });

  afterEach(() => {
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_FINDINGS;
    tmp.cleanup();
  });

  it("persists auto-extracted findings at high", async () => {
    process.env.CORTEX_PROACTIVITY_FINDINGS = "high";

    const res = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: "Race condition on reconnect can surface after ECONNRESET during warmup.",
    }));

    expect(res.ok).toBe(true);
    expect(addFindingsToFile).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit signal at medium before persisting findings', async () => {
    process.env.CORTEX_PROACTIVITY_FINDINGS = "medium";

    const blocked = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: "Race condition on reconnect can surface after ECONNRESET during warmup.",
    }));
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('requires an explicit signal');
    expect(addFindingsToFile).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();

    const allowed = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: "This is worth remembering: retry the socket handshake once after ECONNRESET.",
    }));
    expect(allowed.ok).toBe(true);
    expect(addFindingsToFile).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("blocks auto-extracted finding persistence at low", async () => {
    process.env.CORTEX_PROACTIVITY_FINDINGS = "low";

    const res = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: 'Add finding: retry the socket handshake once after ECONNRESET.',
    }));

    expect(res.ok).toBe(false);
    expect(res.error).toContain('disabled');
    expect(addFindingsToFile).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
