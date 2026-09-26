import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadCustomCommands,
  parseCommandMarkdown,
  substituteArguments,
  expandCustomCommand,
} from "../custom-commands.js";
import { COMMAND_NAMES, resolveCustomCommand, setCustomCommands, getCustomCommands } from "../commands.js";

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeCommand(dir: string, name: string, contents: string): void {
  const commandsDir = path.join(dir, ".phren-agent", "commands");
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, `${name}.md`), contents);
}

afterEach(() => {
  setCustomCommands([]);
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("parseCommandMarkdown", () => {
  it("parses description frontmatter and the body", () => {
    const parsed = parseCommandMarkdown("---\ndescription: Greet someone\n---\nSay hi to $ARGUMENTS");
    expect(parsed.description).toBe("Greet someone");
    expect(parsed.body).toBe("Say hi to $ARGUMENTS");
  });

  it("treats a file without frontmatter as all body", () => {
    expect(parseCommandMarkdown("Just do $ARGUMENTS").body).toBe("Just do $ARGUMENTS");
  });
});

describe("substituteArguments", () => {
  it("replaces $ARGUMENTS with the whole argument string", () => {
    expect(substituteArguments("fix $ARGUMENTS now", "the bug")).toBe("fix the bug now");
  });

  it("replaces positional $1 and $2", () => {
    expect(substituteArguments("$1 then $2", "alpha beta")).toBe("alpha then beta");
  });
});

describe("custom command loading and expansion", () => {
  it("loads markdown commands and expands $ARGUMENTS", () => {
    const home = tmp("phren-home-");
    const cwd = tmp("phren-cwd-");
    writeCommand(cwd, "greet", "---\ndescription: Greet\n---\nSay hello to $ARGUMENTS. First word: $1");

    const commands = loadCustomCommands(cwd, { home });
    expect(commands.map((c) => c.name)).toEqual(["greet"]);
    expect(commands[0].description).toBe("Greet");

    setCustomCommands(commands);
    const expanded = resolveCustomCommand("/greet world extra");
    expect(expanded).toContain("Say hello to world extra.");
    expect(expanded).toContain("First word: world");
    expect(COMMAND_NAMES).toContain("/greet");
  });

  it("lets built-in commands win over a same-named custom command", () => {
    const home = tmp("phren-home-");
    const cwd = tmp("phren-cwd-");
    writeCommand(cwd, "help", "custom help body");
    setCustomCommands(loadCustomCommands(cwd, { home }));
    expect(resolveCustomCommand("/help")).toBeNull();
    expect(COMMAND_NAMES.filter((name) => name === "/help")).toHaveLength(1);
    expect(getCustomCommands()).toHaveLength(0);
  });

  it("prefers the project command over the user command", () => {
    const home = tmp("phren-home-");
    const cwd = tmp("phren-cwd-");
    writeCommand(home, "greet", "from user");
    writeCommand(cwd, "greet", "from project");
    const commands = loadCustomCommands(cwd, { home });
    expect(commands).toHaveLength(1);
    expect(commands[0].body).toBe("from project");
    expect(commands[0].source).toBe("project");
  });

  it("returns null for unknown commands and non-slash input", () => {
    expect(resolveCustomCommand("/missing")).toBeNull();
    expect(resolveCustomCommand("just text")).toBeNull();
  });

  it("expands a command with no arguments to its body", () => {
    const command = { name: "status", body: "Report status", source: "project" as const, path: "/x" };
    expect(expandCustomCommand(command, "")).toBe("Report status");
  });
});
