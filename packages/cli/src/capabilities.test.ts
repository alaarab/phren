import { describe, expect, it } from "vitest";
import {
  cliManifest,
  mcpManifest,
  vscodeManifest,
  webUiManifest,
} from "./capabilities/index.js";

describe("capability registry", () => {
  for (const manifest of [cliManifest, mcpManifest, vscodeManifest, webUiManifest]) {
    describe(`${manifest.surface} manifest`, () => {
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
});
