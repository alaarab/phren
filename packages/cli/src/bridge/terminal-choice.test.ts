import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { numberedDialog, visibleTerminalChoice } from "./terminal-choice.js";

const recorded = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");

describe("terminal choices inside a drawn frame", () => {
  // Copilot CLI draws every select inside a box, so each row starts with "│".
  const trust = recorded("copilot/1.0.88/folder-trust.txt");

  it("reads Copilot's boxed dialog as its question and options", () => {
    expect(visibleTerminalChoice(trust)).toEqual({ title: "Confirm folder trust\n/tmp/copilot-probe\n"
      + "Copilot can read files in this folder and, with your permission, edit them or run code and shell\n"
      + "commands. It will remember your permissions for the rest of this session.\n"
      + "Do you trust the files in this folder?", highlightedIndex: 0, options: [
      { label: "Yes", key: "1", hasKey: false },
      { label: "Yes, and remember this folder for future sessions", key: "2", hasKey: false },
      { label: "No", key: "Escape", hasKey: true },
    ] });
  });

  it("reads a boxed shell permission the same way, command in the question", () => {
    const shell = trust
      .replace("Confirm folder trust        ", "Run shell command           ")
      .replace("/tmp/copilot-probe        ", "node scripts/checks/run.mjs")
      .replace("Do you trust the files in this folder?", "Do you want to run this command?      ")
      .replace("Yes, and remember this folder for future sessions", "Yes, and approve `node` for this session         ");
    const choice = visibleTerminalChoice(shell);
    expect(choice?.title?.split("\n")).toEqual(expect.arrayContaining(["Run shell command", "node scripts/checks/run.mjs", "Do you want to run this command?"]));
    expect(choice?.options.map(option => option.label)).toEqual(["Yes", "Yes, and approve `node` for this session", "No"]);
    expect(choice?.highlightedIndex).toBe(0);
  });

  it("reads the box beside Copilot's scrollbar", () => {
    const scrolled = ["   The pipeline is already unusually thorough.", ...trust.split("\n").filter(Boolean)].map(line => line.padEnd(104) + "┃").join("\n");
    expect(visibleTerminalChoice(scrolled)).toEqual(visibleTerminalChoice(trust));
  });

  it("leaves unframed dialogs as they were", () => {
    expect(numberedDialog("Allow?\n1. Yes\n2. No")).toEqual({ title: "Allow?", options: [{ label: "Yes", key: "1" }, { label: "No", key: "2" }] });
    expect(visibleTerminalChoice("Allow?\n│ not a frame\n› 1. Yes\n  2. No (esc)")?.title).toBe("Allow?\n│ not a frame");
  });
});
