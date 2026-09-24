import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, runCliExec } from "../test-helpers.js";
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

// No TTY used to count as consent, so `phren uninstall` in an agent shell, a CI
// step or a pipe deleted the whole store. --yes is the explicit opt-in.
describe("uninstall: non-interactive sessions", () => {
  it("refuses to delete the store without --yes", () => {
    const tmp = makeTempDir("phren-uninstall-tty-");
    try {
      const home = path.join(tmp.path, "home");
      const phrenDir = path.join(home, ".phren");
      fs.mkdirSync(path.join(phrenDir, "keep-me"), { recursive: true });
      fs.writeFileSync(path.join(phrenDir, "keep-me", "FINDINGS.md"), "# Findings\n- irreplaceable insight\n");

      // runCliExec pipes stdio, so neither stdin nor stdout is a TTY.
      const { exitCode, stdout } = runCliExec(["uninstall"], { PHREN_PATH: phrenDir, HOME: home, USERPROFILE: home });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("--yes");
      expect(stdout).toContain("Uninstall cancelled.");
      expect(fs.readFileSync(path.join(phrenDir, "keep-me", "FINDINGS.md"), "utf8")).toContain("irreplaceable insight");
    } finally {
      tmp.cleanup();
    }
  }, 30_000);
});
