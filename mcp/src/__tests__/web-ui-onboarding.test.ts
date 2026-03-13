import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { createWebUiServer } from "../memory-ui.js";
import type { Server } from "http";

describe.sequential("web-ui onboarding repair", () => {
  let tmp: { path: string; cleanup: () => void };
  let cortexPath: string;
  let homeDir: string;
  let priorHome: string | undefined;
  let priorUserProfile: string | undefined;
  let server: Server | null = null;

  beforeEach(() => {
    tmp = makeTempDir("cortex-web-ui-onboarding-");
    cortexPath = path.join(tmp.path, ".cortex");
    homeDir = path.join(tmp.path, "home");
    priorHome = process.env.HOME;
    priorUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(cortexPath, "machines.yaml"), `${os.hostname()}: default\n`);
    fs.writeFileSync(path.join(cortexPath, "profiles", "default.yaml"), "name: default\nprojects:\n  - global\n");
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
    expect(fs.existsSync(path.join(cortexPath, "global", "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(cortexPath, ".sessions"))).toBe(false);
    expect(fs.existsSync(path.join(cortexPath, ".runtime", "canonical-locks.json"))).toBe(false);
    expect(fs.existsSync(path.join(cortexPath, ".env"))).toBe(false);

    server = createWebUiServer(cortexPath, undefined, "default");

    expect(fs.existsSync(path.join(cortexPath, "global", "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(cortexPath, ".sessions"))).toBe(true);
    expect(fs.existsSync(path.join(cortexPath, ".runtime", "canonical-locks.json"))).toBe(true);
    expect(fs.readFileSync(path.join(cortexPath, ".env"), "utf8")).toContain("CORTEX_FEATURE_AUTO_CAPTURE=1");
  });
});
