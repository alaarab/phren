import { describe, it, expect, afterEach } from "vitest";
import {
  skipGlobalUninstallSideEffects,
  shouldUninstallCurrentGlobalPackage,
} from "./init-uninstall.js";

// Regression guard: a sandboxed `phren uninstall` (as run by the test harness)
// must never shell out to a real `npm uninstall -g @phren/cli`. npm's global
// prefix ignores a sandboxed HOME, so without this flag an uninstall test would
// delete the developer's real global install.
describe("uninstall: global side-effect guard", () => {
  const original = process.env.PHREN_SKIP_GLOBAL_UNINSTALL;
  afterEach(() => {
    if (original === undefined) delete process.env.PHREN_SKIP_GLOBAL_UNINSTALL;
    else process.env.PHREN_SKIP_GLOBAL_UNINSTALL = original;
  });

  it("reports skip when PHREN_SKIP_GLOBAL_UNINSTALL=1", () => {
    process.env.PHREN_SKIP_GLOBAL_UNINSTALL = "1";
    expect(skipGlobalUninstallSideEffects()).toBe(true);
  });

  it("does not skip when the flag is unset", () => {
    delete process.env.PHREN_SKIP_GLOBAL_UNINSTALL;
    expect(skipGlobalUninstallSideEffects()).toBe(false);
  });

  it("never probes/removes the global npm package when skipping (no npm shell-out)", () => {
    process.env.PHREN_SKIP_GLOBAL_UNINSTALL = "1";
    // Returns false immediately, before any `npm root -g` call, regardless of
    // whether a real global install exists on this machine.
    expect(shouldUninstallCurrentGlobalPackage()).toBe(false);
  });
});
