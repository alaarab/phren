import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { historicalImage, TranscriptReader } from "./transcripts.js";

type Handler = (input: unknown, output?: unknown) => Promise<void>;

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// What OpenCode 1.18's read tool leaves on a tool part for a PNG: the text
// output plus one `file` attachment carrying the bytes as a data URL.
const readPart = (callID: string, data: string) => ({
  id: `prt_${callID}`, messageID: "msg_a1", type: "tool", tool: "read", callID,
  state: { status: "completed", input: { filePath: `/tmp/${callID}.png` }, output: "Image read successfully",
    metadata: { preview: "Image read successfully", truncated: false, loaded: [] }, title: `${callID}.png`,
    attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${data}`, id: `prt_file_${callID}`, sessionID: "ses_images", messageID: "msg_a1" }] },
});

it("carries an OpenCode read's picture as an image block the Hook's image route serves", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "phren-oc-images-")); roots.push(store);
  vi.stubEnv("PHREN_PATH", store); vi.stubEnv("PHREN_FANOUT_JOB", ""); vi.useFakeTimers();
  const url = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url);
  const { PhrenTranscriptPlugin } = await import(/* @vite-ignore */ url.href) as { PhrenTranscriptPlugin: () => Promise<Record<string, Handler>> };
  const plugin = await PhrenTranscriptPlugin();
  const sessionID = "ses_images";
  const event = (type: string, properties: Record<string, unknown>) => plugin.event({ event: { type, properties: { sessionID, ...properties } } });
  const picture = Buffer.from("\x89PNG\r\n\x1a\nfixture-picture");
  const oversized = Buffer.alloc(3_100_000, 7).toString("base64");

  await event("message.updated", { info: { id: "msg_a1", role: "assistant", finish: "tool-calls", time: { created: 1_000, completed: 2_000 } } });
  await event("message.part.updated", { part: readPart("call_small", picture.toString("base64")) });
  await event("message.part.updated", { part: readPart("call_huge", oversized) });
  await event("message.part.updated", { part: { id: "prt_bash", messageID: "msg_a1", type: "tool", tool: "bash", callID: "call_bash",
    state: { status: "completed", input: { command: "ls" }, output: "a.txt" } } });
  await vi.advanceTimersByTimeAsync(250);

  const file = path.join(store, ".runtime", "sessions", `opencode-${sessionID}.events.jsonl`);
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const results = rows[1].data.message.content;
  expect(results[0]).toEqual({ type: "tool_result", tool_use_id: "call_small", is_error: false, content: [
    { type: "text", text: "Image read successfully" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: picture.toString("base64") } },
  ] });
  expect(results[1].content).toEqual([
    { type: "text", text: "Image read successfully" },
    { type: "text", text: "[Image not included: too large to show on the phone]" },
  ]);
  expect(results[2].content).toBe("a.txt");
  expect(JSON.stringify(rows)).not.toContain(oversized.slice(0, 200));

  // The chat page keeps the picture's position but not its bytes.
  const page = await new TranscriptReader(file, "opencode").read();
  const listed = (page.entries[1].raw.data as any).message.content[0].content;
  expect(listed[1]).toEqual({ type: "image" });
  expect(JSON.stringify(page)).not.toContain(picture.toString("base64"));
  expect(await historicalImage(file, 1, 0, "opencode", 1)).toEqual(picture);
  await expect(historicalImage(file, 1, 0, "opencode", 0)).rejects.toThrow(/not embedded/);
});
