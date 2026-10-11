// Real Hook backlog frames (packages/cli/fixtures/conformance) read through the
// ported transcript reader: the frames the phones also read must parse into a
// well-formed conversation here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readTranscriptFrame, type ChatSource } from "./transcript.js";

const fixtures: Array<[string, ChatSource]> = [
  ["codex-0.157.1-backlog.json", "codex"],
  ["copilot-1.0.87-backlog.json", "copilot"],
];

describe("conformance backlogs", () => {
  for (const [file, source] of fixtures) {
    it(`${file} reads into a well-formed conversation`, () => {
      const frame = JSON.parse(readFileSync(new URL(`../../cli/fixtures/conformance/${file}`, import.meta.url), "utf8"));
      const transcript = readTranscriptFrame(frame, source);
      const messages = transcript.messages;
      expect(messages.length).toBeGreaterThan(0);
      expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
      for (const m of messages) {
        expect(["user", "assistant", "tool"]).toContain(m.role);
        expect(typeof m.text).toBe("string");
        expect(Number.isInteger(m.line)).toBe(true);
      }
      expect(messages.some((m) => m.role === "user")).toBe(true);
      expect(messages.some((m) => m.role === "assistant")).toBe(true);
    });
  }
});
