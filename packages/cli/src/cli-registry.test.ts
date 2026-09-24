import { describe, expect, it } from "vitest";
import {
  REGISTRY,
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

  it("every entry has a non-empty usage and summary", () => {
    for (const cmd of REGISTRY) {
      expect(cmd.usage.trim().length, `${cmd.name}: empty usage`).toBeGreaterThan(0);
      expect(cmd.summary.trim().length, `${cmd.name}: empty summary`).toBeGreaterThan(0);
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

