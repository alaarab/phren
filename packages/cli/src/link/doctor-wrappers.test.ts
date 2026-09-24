import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { wrapperCheck, wrapperState } from "./doctor.js";

describe.skipIf(process.platform === "win32")("doctor's wrapper checks", () => {
  let tmp: { path: string; cleanup: () => void };
  let home: string;
  let localBin: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmp = makeTempDir("doctor-wrappers-");
    home = tmp.path;
    localBin = path.join(home, ".local", "bin");
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    tmp.cleanup();
  });

  const installWrapper = (tool: string) => {
    writeFile(path.join(localBin, tool), "#!/bin/sh\n# PHREN_CLI_WRAPPER\n");
    fs.chmodSync(path.join(localBin, tool), 0o755);
  };
  const neverResolves = () => {
    throw new Error("PATH lookup must not run when ~/.local/bin is off PATH");
  };

  it("an installed wrapper is not reported missing when ~/.local/bin is only added by .zshrc", () => {
    installWrapper("phren");
    installWrapper("cursor");
    // Doctor over SSH or from a LaunchAgent: no interactive shell setup.
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

    const phren = wrapperCheck("phren", wrapperState("phren", env, neverResolves));
    expect(phren.ok).toBe(true);
    expect(phren.detail).toMatch(/installed at ~\/\.local\/bin\/phren.*not on this process's PATH/);

    const cursor = wrapperCheck("cursor", wrapperState("cursor", env, neverResolves));
    expect(cursor).toMatchObject({ name: "wrapper:cursor", ok: true });
  });

  it("is active when the wrapper is what PATH runs", () => {
    installWrapper("phren");
    const state = wrapperState("phren", { PATH: `${localBin}:/usr/bin` }, () => path.join(localBin, "phren"));
    expect(state).toEqual({ state: "active" });
    expect(wrapperCheck("phren", state).ok).toBe(true);
  });

  it("fails and names the binary that runs first when something shadows the wrapper", () => {
    installWrapper("cursor");
    const state = wrapperState("cursor", { PATH: `/opt/homebrew/bin:${localBin}` }, () => "/opt/homebrew/bin/cursor");
    expect(state).toEqual({ state: "shadowed", by: "/opt/homebrew/bin/cursor" });
    expect(wrapperCheck("cursor", state)).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/resolves to \/opt\/homebrew\/bin\/cursor before the wrapper/),
    });
  });

  it("fails as missing only when there is no wrapper file", () => {
    const state = wrapperState("phren", { PATH: `${localBin}:/usr/bin` }, neverResolves);
    expect(state).toEqual({ state: "missing" });
    expect(wrapperCheck("phren", state)).toMatchObject({ ok: false, detail: expect.stringMatching(/missing/) });
  });
});
