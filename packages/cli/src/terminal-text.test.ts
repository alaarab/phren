import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripTerminal } from "./terminal-text.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge", "fixtures");
const herdr = JSON.parse(readFileSync(path.join(fixtures, "herdr", "0.9.1", "responses.json"), "utf8"));
// Recorded screens: Herdr's pane.read of Codex's trust prompt, and Codex's permissions menu.
const trustPrompt: string = herdr["pane.read"].response.result.read.text;
const permissionsMenu = readFileSync(path.join(fixtures, "codex", "0.155.1", "permissions-menu.txt"), "utf8");

describe("stripTerminal", () => {
  it.each([
    ["SGR colors", "\x1b[1;38;2;40;211;242mphren\x1b[0m ready\x1b[m", "phren ready"],
    ["private-mode CSI", "\x1b[?25l\x1b[?2004hdrawing\x1b[?25h", "drawing"],
    ["CSI with < = > parameters", "\x1b[>4;2mkeys\x1b[<u", "keys"],
    ["cursor and erase CSI", "\x1b[2K\x1b[1Gline\x1b[K", "line"],
    ["OSC title ended by BEL", "\x1b]0;✳ Claude Code\x07❯ prompt", "❯ prompt"],
    ["OSC hyperlink ended by ST", "see \x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\ now", "see docs now"],
    ["two OSCs ended by ST keep the text between them", "\x1b]2;a\x1b\\mid\x1b]2;b\x1b\\", "mid"],
    ["CRLF and lone carriage returns", "one\r\ntwo\rthree\r\n", "one\ntwothree\n"],
    ["OpenCode stats row", "\x1b[1mTotal Cost\x1b[22m   \x1b[32m$12.34\x1b[39m\r\n", "Total Cost   $12.34\n"],
    ["box drawing and spinners are kept", "\x1b[2m╭──╮\x1b[0m ✳ Pondering… ⠋", "╭──╮ ✳ Pondering… ⠋"],
    ["plain text is unchanged", "sam@Desk ws % codex", "sam@Desk ws % codex"],
  ])("%s", (_name, input, expected) => {
    expect(stripTerminal(input)).toBe(expected);
  });

  it.each([
    ["Herdr pane.read of the Codex trust prompt", trustPrompt],
    ["Codex permissions menu", permissionsMenu],
  ])("returns the recorded %s as it was drawn", (_name, screen) => {
    const drawn = screen.split("\n").map((line, index) =>
      `\x1b[${index % 2 ? "2" : "38;5;99"}m${line}\x1b[0m\x1b[K`).join("\r\n");
    expect(stripTerminal(`\x1b]0;Codex\x07${drawn}`)).toBe(screen);
  });
});
