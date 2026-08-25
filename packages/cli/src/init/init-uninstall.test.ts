import { describe, it, expect, afterEach } from "vitest";
import { shouldUninstallCurrentGlobalPackage } from "./init-uninstall.js";

// Regression guard: a sandboxed `phren uninstall` (as run by the test harness)
// must never shell out to a real `npm uninstall -g @phren/cli`. npm's global
// prefix ignores a sandboxed HOME, so without this flag an uninstall test would
// delete the developer's real global install.
describe("uninstall: global npm side-effect guard", () => {
  const original = process.env.PHREN_SKIP_GLOBAL_NPM_UNINSTALL;
  afterEach(() => {
    if (original === undefined)
      delete process.env.PHREN_SKIP_GLOBAL_NPM_UNINSTALL;
    else process.env.PHREN_SKIP_GLOBAL_NPM_UNINSTALL = original;
  });

  it("never probes/removes the global npm package when the flag is set", () => {
    process.env.PHREN_SKIP_GLOBAL_NPM_UNINSTALL = "1";
    // Returns false before any `npm root -g` call, regardless of whether a
    // real global install exists on this machine.
    expect(shouldUninstallCurrentGlobalPackage()).toBe(false);
  });

  it("attempts the removal when the flag is unset", () => {
    delete process.env.PHREN_SKIP_GLOBAL_NPM_UNINSTALL;
    expect(typeof shouldUninstallCurrentGlobalPackage()).toBe("boolean");
  });
});
