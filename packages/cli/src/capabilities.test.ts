import { describe, expect, it } from "vitest";
import {
  ACTION_KEYS,
  ALL_MANIFESTS,
  cliManifest,
  mcpManifest,
  vscodeManifest,
  webUiManifest,
  type ActionKey,
  type CapabilityManifest,
} from "./capabilities/index.js";

describe("capability registry", () => {
  const manifests: CapabilityManifest[] = ALL_MANIFESTS;

  it("exports exactly 4 surface manifests", () => {
    expect(manifests).toHaveLength(4);
    const surfaces = manifests.map((m) => m.surface).sort();
    expect(surfaces).toEqual(["cli", "mcp", "vscode", "web-ui"]);
  });

  for (const manifest of [cliManifest, mcpManifest, vscodeManifest, webUiManifest]) {
    describe(`${manifest.surface} manifest`, () => {
      it("contains every ActionKey", () => {
        const keys = Object.keys(manifest.actions).sort();
        const expected = [...ACTION_KEYS].sort();
        expect(keys).toEqual(expected);
      });

      it("has a reason for every unimplemented action", () => {
        const missing: string[] = [];
        for (const [key, entry] of Object.entries(manifest.actions)) {
          if (!entry.implemented && !entry.reason) {
            missing.push(key);
          }
        }
        expect(missing).toEqual([]);
      });

      it("has a handler for every implemented action", () => {
        const missing: string[] = [];
        for (const [key, entry] of Object.entries(manifest.actions)) {
          if (entry.implemented && !entry.handler) {
            missing.push(key);
          }
        }
        expect(missing).toEqual([]);
      });
    });
  }

  it("produces a parity diff summary", () => {
    const gaps: Array<{ action: ActionKey; surface: string; reason: string }> = [];
    for (const key of ACTION_KEYS) {
      for (const manifest of manifests) {
        const entry = manifest.actions[key];
        if (!entry.implemented) {
          gaps.push({ action: key, surface: manifest.surface, reason: entry.reason || "unknown" });
        }
      }
    }
    // Every gap must have a reason (already tested above), but let's verify the summary is non-empty
    // since not all surfaces implement everything
    expect(gaps.length).toBeGreaterThan(0);

    // Verify we can group by action
    const byAction = new Map<string, string[]>();
    for (const gap of gaps) {
      const arr = byAction.get(gap.action) || [];
      arr.push(gap.surface);
      byAction.set(gap.action, arr);
    }
    expect(byAction.size).toBeGreaterThan(0);
  });

  it("all manifests share the same version", () => {
    const versions = new Set(manifests.map((m) => m.version));
    expect(versions.size).toBe(1);
  });
});
