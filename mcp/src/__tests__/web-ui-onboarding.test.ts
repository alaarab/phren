import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { createWebUiServer } from "../memory-ui.js";
import type { Server } from "http";

describe.sequential("web-ui onboarding repair", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;
  let homeDir: string;
  let priorHome: string | undefined;
  let priorUserProfile: string | undefined;
  let server: Server | null = null;

  beforeEach(() => {
    tmp = makeTempDir("phren-web-ui-onboarding-");
    phrenPath = path.join(tmp.path, ".phren");
    homeDir = path.join(tmp.path, "home");
    priorHome = process.env.HOME;
    priorUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(phrenPath, "machines.yaml"), `${os.hostname()}: default\n`);
    fs.writeFileSync(path.join(phrenPath, "profiles", "default.yaml"), "name: default\nprojects:\n  - global\n");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    server = null;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    tmp.cleanup();
  });

  it("self-repairs baseline assets before serving requests", async () => {
    expect(fs.existsSync(path.join(phrenPath, "global", "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(phrenPath, ".sessions"))).toBe(false);
    expect(fs.existsSync(path.join(phrenPath, ".env"))).toBe(false);

    server = createWebUiServer(phrenPath, undefined, "default");

    expect(fs.existsSync(path.join(phrenPath, "global", "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(phrenPath, ".sessions"))).toBe(true);
    expect(fs.readFileSync(path.join(phrenPath, ".env"), "utf8")).toContain("PHREN_FEATURE_AUTO_CAPTURE=1");
  });
});
