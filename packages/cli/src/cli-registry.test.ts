import { describe, expect, it } from "vitest";
import {
  REGISTRY,
} from "./cli-registry.js";

describe("cli-registry: shape invariants", () => {
  it("every entry is unique, described, not both featured and hidden, with unique subcommands", () => {
    const seen = new Set<string>();
    for (const cmd of REGISTRY) {
      expect(seen.has(cmd.name), `duplicate name: ${cmd.name}`).toBe(false);
      seen.add(cmd.name);
      expect(cmd.featured && cmd.hidden, `${cmd.name}: featured and hidden are mutually exclusive`).toBeFalsy();
      expect(cmd.usage.trim().length, `${cmd.name}: empty usage`).toBeGreaterThan(0);
      expect(cmd.summary.trim().length, `${cmd.name}: empty summary`).toBeGreaterThan(0);
      const subs = new Set<string>();
      for (const sub of cmd.subcommands ?? []) {
        expect(subs.has(sub.name), `${cmd.name}.${sub.name}: duplicate subcommand`).toBe(false);
        subs.add(sub.name);
      }
    }
  });
});

