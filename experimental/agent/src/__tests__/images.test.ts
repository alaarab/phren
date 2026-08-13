import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LlmMessage, ToolResultBlock } from "../providers/types.js";
import { toolResultText } from "../providers/types.js";
import { IMAGE_OMITTED_MARKER } from "../providers/history.js";
import { toOpenAiMessages } from "../providers/openai-compat.js";
import { toResponsesInput } from "../providers/codex.js";
import { estimateMessageTokens, estimateImageTokens } from "../context/token-counter.js";
import { createReadImageTool } from "../tools/read-image.js";
import type { LlmProvider } from "../providers/types.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
  "base64",
);

function imageResult(withText = "screenshot captured"): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: "call_img",
    content: [
      { type: "text", text: withText },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX.toString("base64") } },
    ],
  };
}

describe("toolResultText", () => {
  it("returns string content as-is", () => {
    expect(toolResultText({ type: "tool_result", tool_use_id: "x", content: "plain" })).toBe("plain");
  });

  it("joins text parts and ignores images", () => {
    expect(toolResultText(imageResult("hello"))).toBe("hello");
  });
});

describe("token counting for images", () => {
  it("prices an image by its byte size with a floor", () => {
    // 100k base64 chars = 75k bytes -> 100 tokens
    expect(estimateImageTokens("A".repeat(100_000))).toBe(100);
    expect(estimateImageTokens("AA")).toBe(64); // floor
  });

  it("counts images inside tool results", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: [imageResult()] }];
    const withImage = estimateMessageTokens(msgs);
    const withoutImage = estimateMessageTokens([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_img", content: "screenshot captured" }] },
    ]);
    expect(withImage).toBeGreaterThan(withoutImage);
  });
});

describe("openai-compat image serialization", () => {
  const history: LlmMessage[] = [{ role: "user", content: [imageResult()] }];

  it("emits a data-URI image_url user message after the tool message on vision models", () => {
    const out = toOpenAiMessages("sys", history, "openai", true);
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "call_img", content: "screenshot captured" });
    const imgMsg = out[2] as { role: string; content: Array<{ type: string; image_url?: { url: string } }> };
    expect(imgMsg.role).toBe("user");
    expect(imgMsg.content[0].type).toBe("image_url");
    expect(imgMsg.content[0].image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("degrades images to a marker on text-only models instead of failing", () => {
    const out = toOpenAiMessages("sys", history, "openai", false);
    expect(out[2]).toEqual({ role: "user", content: IMAGE_OMITTED_MARKER });
  });
});

describe("codex image serialization", () => {
  const history: LlmMessage[] = [{ role: "user", content: [imageResult()] }];

  it("emits input_image parts on vision models", () => {
    const input = toResponsesInput(history, true);
    expect(input[0]).toEqual({ type: "function_call_output", call_id: "call_img", output: "screenshot captured" });
    const imgMsg = input[1] as { type: string; content: Array<{ type: string; image_url?: string }> };
    expect(imgMsg.content[0].type).toBe("input_image");
    expect(imgMsg.content[0].image_url).toMatch(/^data:image\/png;base64,/);
  });

  it("degrades to the marker on text-only models", () => {
    const input = toResponsesInput(history, false);
    expect(input[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: IMAGE_OMITTED_MARKER }],
    });
  });
});

describe("read_image tool", () => {
  function visionProvider(vision: boolean): LlmProvider {
    return {
      name: "anthropic",
      model: vision ? "claude-sonnet-4-20250514" : "unknown-text-model",
      async chat() {
        throw new Error("unused");
      },
    };
  }

  it("reads a png into a base64 image attachment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-img-"));
    const file = path.join(dir, "pixel.png");
    fs.writeFileSync(file, PNG_1PX);
    const savedCwd = process.cwd();
    process.chdir(dir);
    try {
      const tool = createReadImageTool(visionProvider(true));
      const result = await tool.execute({ path: file });
      expect(result.is_error).toBeUndefined();
      expect(result.images).toHaveLength(1);
      expect(result.images![0].media_type).toBe("image/png");
      expect(Buffer.from(result.images![0].data, "base64")).toEqual(PNG_1PX);
    } finally {
      process.chdir(savedCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses on a text-only model even though it executed", async () => {
    const tool = createReadImageTool(visionProvider(false));
    const result = await tool.execute({ path: "whatever.png" });
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("does not accept image input");
  });

  it("rejects unsupported extensions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-img-"));
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "text");
    const savedCwd = process.cwd();
    process.chdir(dir);
    try {
      const tool = createReadImageTool(visionProvider(true));
      const result = await tool.execute({ path: file });
      expect(result.is_error).toBe(true);
      expect(result.output).toContain("Unsupported image type");
    } finally {
      process.chdir(savedCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
