import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { historicalImage, TranscriptReader } from "./transcripts.js";
import type { Json, Provider } from "./protocol.js";

const text = { type: "text", text: "Keep this text and data:image/png;base64,AAAA unchanged." };
type Fixture = { name: string; source: Provider; event: (image: Json) => Json };
const fixtures: Fixture[] = [
  { name: "Claude tool result", source: "claude", event: image => ({ type: "user", message: { role: "user", content: [
    text, { type: "tool_result", tool_use_id: "tool-1", is_error: false, content: [text, image, text] }, text,
  ] } }) },
  { name: "Codex structured tool output", source: "codex", event: image => ({ type: "response_item",
    payload: { type: "function_call_output", call_id: "tool-1", output: [text, image, text] } }) },
  { name: "Codex wrapped custom tool output", source: "codex", event: image => ({ type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "tool-1", output: { content: [text, image, text], isError: false } } }) },
  { name: "Copilot user content", source: "copilot", event: image => ({ type: "user.message", data: { source: "user", content: [text, image, text] } }) },
  { name: "Copilot assistant content", source: "copilot", event: image => ({ type: "assistant.message", data: { content: [text, image, text] } }) },
  { name: "Copilot tool result", source: "copilot", event: image => ({ type: "tool.execution_complete",
    data: { toolCallId: "tool-1", result: { content: [text, image, text], isError: false } } }) },
];

describe("transcript image payloads", () => {
  let root: string, file: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-transcript-")); file = path.join(root, "transcript.jsonl"); });
  afterEach(async () => { await rm(root, { recursive: true }); });

  it.each(fixtures)("omits embedded bytes from $name without losing the row or surrounding text", async ({ source, event }) => {
    // This image exceeds the normal 2 MiB entry budget before sanitizing. The
    // text must remain readable instead of losing the entire tool result.
    const encoded = Buffer.alloc(1_650_000, 37).toString("base64");
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: encoded } };
    const original = JSON.stringify(event(image)) + "\n";
    await writeFile(file, original);
    const page = await new TranscriptReader(file, source).read();
    expect(page.entries).toEqual([{ line: 0, raw: event({ type: "image" }) }]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2_000);
    expect(page).toMatchObject({ totalLines: 1, startLine: 0, hasMore: false });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("strips structured data URLs while preserving string results, tool arguments, and unknown blocks", async () => {
    const url = "data:image/png;base64," + Buffer.alloc(100_000, 37).toString("base64");
    const structuredImage = { type: "input_image", image_url: url };
    const events = [
      { type: "response_item", payload: { type: "function_call_output", call_id: "image", output: [text, structuredImage, { type: "unknown", data: url }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "text", output: JSON.stringify(structuredImage) } },
      { type: "response_item", payload: { type: "function_call", call_id: "arguments", name: "inspect", arguments: { content: [structuredImage] } } },
    ];
    await writeFile(file, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const page = await new TranscriptReader(file, "codex").read();
    expect(page.entries.map(entry => entry.raw)).toEqual([
      { ...events[0], payload: { ...events[0].payload, output: [text, { type: "input_image" }, { type: "unknown", data: url }] } },
      events[1], events[2],
    ]);
  });

  it.each(["codex", "claude"] as const)("keeps %s direct image positions retrievable from the original row", async source => {
    const bytes = Buffer.alloc(2_048, 37);
    const image = source === "codex" ? { type: "input_image", image_url: "data:image/png;base64," + bytes.toString("base64") }
      : { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } };
    const event = source === "codex" ? { type: "response_item", payload: { type: "message", role: "user", content: [text, image, text] } }
      : { type: "user", message: { role: "user", content: [text, image, text] } };
    await writeFile(file, JSON.stringify(event) + "\n");
    const page = await new TranscriptReader(file, source).read();
    const message = page.entries[0].raw[source === "codex" ? "payload" : "message"] as Json;
    expect(message.content).toEqual([text, { type: image.type }, text]);
    expect(await historicalImage(file, 0, 1, source)).toEqual(bytes);
  });
});
