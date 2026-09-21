import { BUILTIN_MODULES } from "./modules/registry.js";
import { commandsForModules, disabledCommand } from "./cli-registry.js";
import type { ModuleSnapshot } from "./modules/runtime.js";
import { describe, expect, it } from "vitest";
import {
  formatCheatSheet,
  formatCommand,
  formatDocTopic,
  formatFullHelp,
  formatTopic,
} from "./cli-help.js";
import { REGISTRY } from "./cli-registry.js";

describe("formatCheatSheet", () => {
  const out = formatCheatSheet();

  it("contains the phren title and the bare `phren` line", () => {
    expect(out).toContain("phren - persistent memory for AI agents");
    expect(out).toContain("Interactive memory shell");
  });

  it("contains the manage/mem alias footer (asserted by cli.test.ts)", () => {
    expect(out).toContain("phren manage <command>");
    expect(out).toContain("phren mem <command>");
  });

  it("contains featured commands", () => {
    expect(out).toContain("phren init");
    expect(out).toContain("phren search");
    expect(out).toContain("phren add");
  });

  it("does not contain forbidden tokens (asserted by cli.test.ts)", () => {
    expect(out).not.toContain("projects add");
    expect(out).not.toContain("phren link");
    expect(out).not.toContain("--from-existing");
  });

  it("excludes hidden commands", () => {
    expect(out).not.toContain("hook-prompt");
    expect(out).not.toContain("background-sync");
    expect(out).not.toContain("inspect-index");
    expect(out).not.toContain("debug-injection");
  });

  it("lists topics including doc topics and `all`", () => {
    expect(out).toContain("Topics:");
    expect(out).toContain("env");
    expect(out).toContain("all");
  });
});

describe("formatTopic", () => {
  it("projects topic includes both `add` and `projects` subcommands", () => {
    const out = formatTopic("projects");
    expect(out).toContain("phren add");
    expect(out).toContain("phren projects list");
    expect(out).toContain("phren projects remove <name>");
  });

  it("skills topic includes the skills namespace and detect-skills", () => {
    const out = formatTopic("skills");
    expect(out).toContain("phren skills list");
    expect(out).toContain("phren skills add <project> <path>");
    expect(out).toContain("phren detect-skills");
  });

  it("hides hidden commands within topics", () => {
    const out = formatTopic("config");
    expect(out).not.toContain("phren policy ");
    expect(out).not.toContain("phren workflow ");
    expect(out).not.toContain("phren index-policy");
  });
});

describe("formatCommand", () => {
  it("renders a top-level summary for non-namespace commands", () => {
    const out = formatCommand("add");
    expect(out).not.toBeNull();
    expect(out!).toContain("phren add");
    expect(out!).toContain("Register a project");
  });

  it("renders subcommand lines for namespace commands", () => {
    const out = formatCommand("skills");
    expect(out).not.toBeNull();
    expect(out!).toContain("Subcommands:");
    expect(out!).toContain("phren skills list");
    expect(out!).toContain("phren skills add <project> <path>");
    expect(out!).toContain("phren skills remove <project> <name>");
  });

  it("preserves the projects subcommand list (asserted by cli.test.ts)", () => {
    const out = formatCommand("projects");
    expect(out).not.toBeNull();
    expect(out!).toContain("phren projects list");
    expect(out!).toContain("phren projects remove <name>");
    expect(out!).not.toContain("projects add");
  });

  it("returns content for hidden commands so operators can read their help", () => {
    expect(formatCommand("hook-prompt")).not.toBeNull();
    expect(formatCommand("link")).not.toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(formatCommand("absolutely-not-a-command")).toBeNull();
  });
});

describe("formatDocTopic", () => {
  it("returns env-var documentation for `env`", () => {
    const out = formatDocTopic("env");
    expect(out).not.toBeNull();
    expect(out!).toContain("PHREN_PATH");
    expect(out!).toContain("Environment variables");
  });

  it("returns null for non-doc names", () => {
    expect(formatDocTopic("projects")).toBeNull();
    expect(formatDocTopic("nonsense")).toBeNull();
  });
});

describe("formatFullHelp", () => {
  const out = formatFullHelp();

  it("includes every non-hidden command's usage line", () => {
    for (const cmd of REGISTRY) {
      if (cmd.hidden) continue;
      expect(out, `missing ${cmd.name}`).toContain(cmd.usage);
    }
  });

  it("excludes hidden commands' usage lines", () => {
    const hidden = REGISTRY.filter((c) => c.hidden);
    for (const cmd of hidden) {
      // A hidden command may still appear in the env doc body or elsewhere by
      // coincidence, so the assertion looks at the topic-rendered usage line.
      const topicLine = `  ${cmd.usage}`;
      expect(out, `${cmd.name} should not appear in full help as a command line`).not.toContain(topicLine);
    }
  });

  it("includes the env doc topic body", () => {
    expect(out).toContain("PHREN_PATH");
  });
});


describe("module-aware help", () => {
  const snapshot: ModuleSnapshot = { store: "/store", profile: "work", generation: "test",
    modules: BUILTIN_MODULES.filter(module => ["memory", "hook"].includes(module.name)),
    has: name => ["memory", "hook"].includes(name) };
  it("hides commands, aliases and separately owned nested commands together", () => {
    const help = formatFullHelp(snapshot);
    for (const command of ["phren task ", "phren tasks", "phren schedule", "phren dispatch", "phren maintain extract", "enroll-computer"]) expect(help).not.toContain(command);
    expect(formatCommand("tasks", snapshot)).toBeNull();
    expect(formatCommand("bridge", snapshot)).not.toContain("enroll-computer");
    expect(formatCommand("maintain", snapshot)).not.toContain("maintain extract");
    expect(help).toContain("phren modules");
    expect(disabledCommand("extract-memories demo", snapshot)).toContain("enable it with phren modules enable git");
  });
  it("guards a nested dispatch even when the namespace is enabled", async () => {
    const bridge = commandsForModules(snapshot).find(command => command.name === "bridge")!;
    expect(await bridge.run(["enroll-computer", "Desk"], { phrenPath: () => "/store", profile: () => "work" })).toBe(1);
  });
});
