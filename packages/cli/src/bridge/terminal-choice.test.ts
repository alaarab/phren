import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { numberedDialog, opencodePermissionDialog, visibleTerminalChoice } from "./terminal-choice.js";

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

describe("OpenCode's permission prompt", () => {
  // As OpenCode 1.18.32 draws it: the selected option on the warning color,
  // the others on the panel's background.
  const cell = (label: string, selected: boolean) => selected
    ? `\x1b[0m\x1b[38;2;10;10;10m\x1b[48;2;245;167;66m${label}\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  `
    : `\x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30m${label}\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   `;
  const screen = (selected: number) => [
    "     $ ls ~/apps",
    "     ▣  Build · DeepSeek V4.1 Flash",
    "  ┃",
    "  ┃  △ Permission required",
    "  ┃    ← Access external directory ~/apps",
    "  ┃",
    "  ┃  Patterns",
    "  ┃",
    "  ┃  - /Users/me/apps/*",
    "  ┃" + " ".repeat(140) + "~/work/phone",
    "  ┃   " + ["Allow once", "Allow always", "Reject"].map((label, index) => cell(label, index === selected)).join("")
      + "\x1b[38;2;238;238;238m\x1b[48;2;30;30;30mctrl+f \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mfullscreen  ⇆ select  enter confirm\x1b[0m",
    "  ┃" + " ".repeat(140) + "• OpenCode 1.18.32",
  ].join("\r\n");

  it("reads the question and offers Allow once and Reject", () => {
    expect(opencodePermissionDialog(screen(0))).toEqual({ selected: 0, choice: {
      title: "Permission required\n← Access external directory ~/apps\nPatterns\n- /Users/me/apps/*", highlightedIndex: 0,
      options: [{ label: "Allow once", key: "1", hasKey: false }, { label: "Reject", key: "Escape", hasKey: true }] } });
  });
  it("finds the cursor from the colors wherever it sits", () => {
    expect(opencodePermissionDialog(screen(1))?.selected).toBe(1);
    expect(opencodePermissionDialog(screen(2))?.selected).toBe(2);
    expect(opencodePermissionDialog(screen(2))?.choice.highlightedIndex).toBeUndefined();
    // Without colors the cursor is unknown, but the question still reads.
    const plain = screen(1).replace(/\x1b\[[0-9;]*m/g, "");
    expect(opencodePermissionDialog(plain)?.selected).toBeUndefined();
    expect(opencodePermissionDialog(plain)?.choice.title).toContain("Access external directory ~/apps");
  });
  it("is nothing without the prompt", () => {
    expect(opencodePermissionDialog("  ┃   Allow once   Allow always   Reject")).toBeUndefined();
    expect(opencodePermissionDialog(screen(0).replace("Reject", "Deny"))).toBeUndefined();
  });
});
