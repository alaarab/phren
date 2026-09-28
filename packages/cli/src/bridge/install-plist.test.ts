import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extraLaunchAgentEnvironment, launchAgentXml, type LaunchAgentValues } from "./install.js";

const values: LaunchAgentValues = { label: "com.phren.hook", node: "/opt/homebrew/bin/node", program: "/Users/me/.local/share/phren/bridge/current/bridge-hook.mjs",
  path: "/opt/homebrew/bin:/usr/bin:/bin", root: "/Users/me/.local/share/phren/bridge", herdr: "/Users/me/.config/herdr", store: "/Users/me/.phren", profile: "mac-mini" };

describe("the Hook's LaunchAgent", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-plist-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("writes exactly phren's own environment when nothing else was set", () => {
    const plist = launchAgentXml(values);
    expect(plist).toContain("<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string><key>PHREN_BRIDGE_HOME</key>");
    expect(plist).toContain("<key>PHREN_PROFILE</key><string>mac-mini</string></dict>");
    expect(plist).not.toContain("PHREN_SPEECH_VOICE");
  });

  // 2026-09-28: `phren bridge update` rewrote the plist and dropped the
  // owner's PHREN_SPEECH_VOICE, so talk mode fell back to the default voice.
  it("keeps every key someone added and never lets one override phren's own", async () => {
    const json = JSON.stringify({ Label: "com.phren.hook", EnvironmentVariables: { PATH: "/tmp/evil", PHREN_PATH: "/tmp/other", PHREN_SPEECH_VOICE: "S9EGwlCtMF7VXtENq79v",
      HTTPS_PROXY: "http://proxy:8080", "bad key": "x", NUMBER: 3 } });
    const extra = await extraLaunchAgentEnvironment("unused", async () => json);
    expect(extra).toEqual({ PHREN_SPEECH_VOICE: "S9EGwlCtMF7VXtENq79v", HTTPS_PROXY: "http://proxy:8080" });
    const plist = launchAgentXml(values, { ...extra, PATH: "/tmp/evil" });
    expect(plist).toContain("<key>PHREN_SPEECH_VOICE</key><string>S9EGwlCtMF7VXtENq79v</string>");
    expect(plist).toContain("<key>HTTPS_PROXY</key><string>http://proxy:8080</string>");
    expect(plist).not.toContain("/tmp/evil");
    expect(await extraLaunchAgentEnvironment(path.join(root, "missing.plist"), async () => { throw new Error("no file"); })).toEqual({});
  });

  it.runIf(process.platform === "darwin")("round-trips through plutil, so an update reads back what it wrote", async () => {
    const file = path.join(root, "com.phren.hook.plist");
    await writeFile(file, launchAgentXml(values, { PHREN_SPEECH_VOICE: "S9EGwlCtMF7VXtENq79v", NOTE: "a & b <c>" }));
    await promisify(execFile)("plutil", ["-lint", file]);
    expect(await extraLaunchAgentEnvironment(file)).toEqual({ PHREN_SPEECH_VOICE: "S9EGwlCtMF7VXtENq79v", NOTE: "a & b <c>" });
    expect(await readFile(file, "utf8")).toContain("a &amp; b &lt;c&gt;");
  });
});
