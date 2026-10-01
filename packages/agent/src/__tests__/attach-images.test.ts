import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { attachImages } from "../attach-images.js";
import type { ContentBlock, LlmMessage, LlmProvider, LlmResponse } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";

vi.mock("../spinner.js", () => ({ createSpinner: () => ({ start() {}, update() {}, stop() {} }), formatTurnHeader: () => "", formatToolCall: () => "" }));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: () => null }));
vi.mock("../memory/error-recovery.js", () => ({ searchErrorRecovery: vi.fn().mockResolvedValue("") }));
vi.mock("../memory/auto-capture.js", () => ({ createCaptureState: () => ({ captured: 0, hashes: new Set(), lastCaptureTime: 0 }), analyzeAndCapture: vi.fn().mockResolvedValue(0) }));
const { runTurn, createSession } = await import("../agent-loop/index.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const dirs: string[] = [];
function dir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "attach-")));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("attachImages", () => {
  it("attaches image paths in their pasted forms, once each, and leaves the text alone", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "a.png"), PNG);
    fs.mkdirSync(path.join(d, "My Shots"));
    fs.writeFileSync(path.join(d, "My Shots", "b c.jpg"), PNG);
    const text = `compare a.png with ${d}/My\\ Shots/b\\ c.jpg and '${d}/My Shots/b c.jpg' and missing.png`;
    const { content, attached } = attachImages(text, d);
    expect(attached).toEqual([path.join(d, "a.png"), path.join(d, "My Shots", "b c.jpg")]);
    const blocks = content as ContentBlock[];
    expect(blocks[0]).toEqual({ type: "text", text });
    expect(blocks.slice(1).map((b) => b.type === "image" && b.source.media_type)).toEqual(["image/png", "image/jpeg"]);
  });

  it("returns plain text when no image file is named, and skips oversized ones", () => {
    const d = dir();
    expect(attachImages("fix the bug in a.ts", d)).toEqual({ content: "fix the bug in a.ts", attached: [], skipped: [] });
    fs.writeFileSync(path.join(d, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
    const big = attachImages("see huge.png", d);
    expect(big.content).toBe("see huge.png");
    expect(big.skipped).toEqual(["huge.png (over 5MB)"]);
  });
});

describe("images in a prompt", () => {
  async function prompt(name: string, model: string) {
    const d = dir();
    fs.writeFileSync(path.join(d, "shot.png"), PNG);
    const cwd = process.cwd();
    process.chdir(d);
    const requests: LlmMessage[][] = [];
    const provider = {
      name, model,
      async chat(_s: string, messages: LlmMessage[]): Promise<LlmResponse> {
        requests.push(structuredClone(messages));
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    } as unknown as LlmProvider;
    try {
      await runTurn("what is wrong in shot.png?", createSession(), { provider, registry: new ToolRegistry(), systemPrompt: "s", maxTurns: 2, verbose: false }, { onStatus() {}, onTextBlock() {} });
    } finally {
      process.chdir(cwd);
    }
    return requests[0][0].content;
  }

  it("go to a model that can see", async () => {
    const content = await prompt("anthropic", "claude-sonnet-5") as ContentBlock[];
    expect(content.map((b) => b.type)).toEqual(["text", "image"]);
  });

  it("stay text for one that can't", async () => {
    expect(await prompt("openai", "gpt-6")).toBe("what is wrong in shot.png?");
  });
});
