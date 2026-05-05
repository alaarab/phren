// Help formatters. Pure functions over the command registry.

import {
  REGISTRY,
  TOPIC_ORDER,
  DOC_TOPICS,
  lookupCommand,
  type Command,
  type Subcommand,
  type Topic,
} from "./cli-registry.js";

const TOPIC_TITLES: Record<Topic, string> = {
  core: "Core commands",
  projects: "Projects",
  skills: "Skills",
  hooks: "Hooks",
  config: "Configuration",
  maintain: "Maintenance",
  setup: "Setup",
  stores: "Stores",
  team: "Team",
};

const ALIGN_COL = 40;

function pad(usage: string, summary: string | undefined): string {
  const text = "  " + usage;
  if (!summary) return text;
  const gap = Math.max(2, ALIGN_COL - text.length);
  return text + " ".repeat(gap) + summary;
}

function visibleCommands(): Command[] {
  return REGISTRY.filter((c) => !c.hidden);
}

function commandsInTopic(topic: Topic): Command[] {
  return visibleCommands().filter((c) => c.topic === topic);
}

function renderCommandLine(cmd: Command): string {
  return pad(cmd.usage, cmd.summary);
}

function renderCheatSheetLine(cmd: Command): string {
  return pad(cmd.cheatUsage ?? cmd.usage, cmd.summary);
}

function renderSubcommandLine(sub: Subcommand): string {
  return pad(sub.usage, sub.summary);
}

function renderCommandWithSubs(cmd: Command): string[] {
  const lines = [renderCommandLine(cmd)];
  if (cmd.subcommands?.length) {
    for (const sub of cmd.subcommands) {
      lines.push(renderSubcommandLine(sub));
    }
  }
  return lines;
}

// ── Cheat sheet (phren --help) ───────────────────────────────────────────────

export function formatCheatSheet(): string {
  const lines: string[] = [];
  lines.push("phren - persistent memory for AI agents");
  lines.push("");
  lines.push(pad("phren", "Interactive memory shell"));
  for (const cmd of visibleCommands()) {
    if (!cmd.featured) continue;
    lines.push(renderCheatSheetLine(cmd));
  }
  lines.push("");
  lines.push(pad("phren manage <command>", "Alias for the top-level commands above"));
  lines.push(pad("phren mem <command>", "Alias for `phren manage`"));
  lines.push("");
  lines.push(pad("phren help <topic>", "Detailed help"));
  lines.push(`Topics: ${[...TOPIC_ORDER, ...Object.keys(DOC_TOPICS), "all"].join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

// ── Topic help (phren help <topic>) ──────────────────────────────────────────

export function formatTopic(topic: Topic): string {
  const cmds = commandsInTopic(topic);
  const lines: string[] = [];
  lines.push(`${TOPIC_TITLES[topic]}:`);
  for (const cmd of cmds) {
    for (const line of renderCommandWithSubs(cmd)) {
      lines.push(line);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ── Doc topic (phren help env) ───────────────────────────────────────────────

export function formatDocTopic(name: string): string | null {
  return DOC_TOPICS[name] ?? null;
}

// ── Single command (phren <name> --help / phren help <name>) ─────────────────

export function formatCommand(name: string): string | null {
  const cmd = lookupCommand(name);
  if (!cmd) return null;
  const lines: string[] = [];
  lines.push(`${cmd.usage}`);
  lines.push(`  ${cmd.summary}`);
  if (cmd.subcommands?.length) {
    lines.push("");
    lines.push("Subcommands:");
    for (const sub of cmd.subcommands) {
      lines.push(renderSubcommandLine(sub));
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ── Full help (phren help all) ───────────────────────────────────────────────

export function formatFullHelp(): string {
  const lines: string[] = [];
  lines.push("phren - persistent knowledge for your agents");
  lines.push("");
  lines.push("Usage:");
  lines.push(pad("phren", "Interactive shell"));
  for (const cmd of visibleCommands()) {
    if (!cmd.featured) continue;
    lines.push(renderCheatSheetLine(cmd));
  }
  lines.push("");
  for (const topic of TOPIC_ORDER) {
    const cmds = commandsInTopic(topic);
    if (!cmds.length) continue;
    lines.push(formatTopic(topic));
  }
  for (const [docName, body] of Object.entries(DOC_TOPICS)) {
    lines.push(`${docName.charAt(0).toUpperCase()}${docName.slice(1)} reference:`);
    lines.push(body);
  }
  return lines.join("\n");
}
