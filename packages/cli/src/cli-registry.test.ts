import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  REGISTRY,
  TOPIC_ORDER,
  DOC_TOPICS,
  helpTopicNames,
  isShimRun,
  lookupCommand,
} from "./cli-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("cli-registry: shape invariants", () => {
  it("every entry has a unique name", () => {
    const seen = new Set<string>();
    for (const cmd of REGISTRY) {
      expect(seen.has(cmd.name), `duplicate name: ${cmd.name}`).toBe(false);
      seen.add(cmd.name);
    }
  });

  it("no entry has both featured and hidden set", () => {
    for (const cmd of REGISTRY) {
      if (cmd.featured && cmd.hidden) {
        throw new Error(`${cmd.name}: featured and hidden are mutually exclusive`);
      }
    }
  });

  it("every topic is in TOPIC_ORDER", () => {
    const valid = new Set<string>(TOPIC_ORDER);
    for (const cmd of REGISTRY) {
      expect(valid.has(cmd.topic), `${cmd.name}: unknown topic "${cmd.topic}"`).toBe(true);
    }
  });

  it("every entry has a non-empty usage and summary", () => {
    for (const cmd of REGISTRY) {
      expect(cmd.usage.trim().length, `${cmd.name}: empty usage`).toBeGreaterThan(0);
      expect(cmd.summary.trim().length, `${cmd.name}: empty summary`).toBeGreaterThan(0);
    }
  });

  it("every entry has a callable run function", () => {
    for (const cmd of REGISTRY) {
      expect(typeof cmd.run, `${cmd.name}: run is not a function`).toBe("function");
    }
  });

  it("subcommand names within a single command are unique", () => {
    for (const cmd of REGISTRY) {
      if (!cmd.subcommands) continue;
      const seen = new Set<string>();
      for (const sub of cmd.subcommands) {
        expect(seen.has(sub.name), `${cmd.name}.${sub.name}: duplicate subcommand`).toBe(false);
        seen.add(sub.name);
      }
    }
  });
});

describe("cli-registry: lookupCommand", () => {
  it("resolves a known command by name", () => {
    expect(lookupCommand("init")?.name).toBe("init");
    expect(lookupCommand("search")?.name).toBe("search");
    expect(lookupCommand("add")?.name).toBe("add");
  });

  it("returns undefined for unknown names", () => {
    expect(lookupCommand("absolutely-not-a-command")).toBeUndefined();
  });

  it("can resolve hidden commands (so `phren hook-prompt --help` works for operators)", () => {
    expect(lookupCommand("hook-prompt")?.name).toBe("hook-prompt");
    expect(lookupCommand("link")?.name).toBe("link");
  });
});

describe("cli-registry: helpTopicNames", () => {
  it("includes every command topic, every doc topic, and `all`", () => {
    const names = helpTopicNames();
    for (const topic of TOPIC_ORDER) {
      expect(names).toContain(topic);
    }
    for (const docTopic of Object.keys(DOC_TOPICS)) {
      expect(names).toContain(docTopic);
    }
    expect(names).toContain("all");
  });
});

describe("cli-registry: switch-case coverage in cli/cli.ts", () => {
  // Phase 1 routes most commands through cli/cli.ts's switch via shim().
  // Adding a registry entry without a matching `case` would crash at the
  // switch's default branch (process.exit(1)). This guard catches the
  // regression at test time. Phase 2 deletes the switch entirely.
  const cliSrc = fs.readFileSync(path.join(__dirname, "cli", "cli.ts"), "utf8");
  const switchCases = new Set<string>(
    [...cliSrc.matchAll(/case\s+"([\w-]+)":/g)].map((m) => m[1]),
  );

  it("every shim'd registry name has a matching case in cli/cli.ts", () => {
    const missing: string[] = [];
    for (const cmd of REGISTRY) {
      if (!isShimRun(cmd.run)) continue;
      if (!switchCases.has(cmd.name)) missing.push(cmd.name);
    }
    expect(missing, `registry shim entries with no switch case: ${missing.join(", ")}`).toEqual([]);
  });

  it("every switch case has a matching registry entry", () => {
    const orphans: string[] = [];
    for (const caseName of switchCases) {
      if (!lookupCommand(caseName)) orphans.push(caseName);
    }
    expect(orphans, `switch cases with no registry entry (dead code): ${orphans.join(", ")}`).toEqual([]);
  });
});
