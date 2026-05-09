import { describe, expect, it } from "vitest";
import {
  REGISTRY,
  TOPIC_ORDER,
  DOC_TOPICS,
  helpTopicNames,
  lookupCommand,
} from "./cli-registry.js";

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

