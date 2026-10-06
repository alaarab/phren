import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { defaultMachineName, persistMachineName } from "./machine-identity.js";
import { updateMachinesYaml } from "./init/setup.js";
import { describeProfileMapping, resolveActiveProfile } from "./profile-store.js";

describe("machine identity and profile resolution", () => {
  let tmpRoot: string;
  let phrenDir: string;
  let homeDir: string;
  let tmpCleanup: () => void;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-profile-store-test-"));
    phrenDir = path.join(tmpRoot, ".phren");
    homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(path.join(phrenDir, "profiles"), { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.writeFileSync(path.join(phrenDir, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - global\n");
    fs.writeFileSync(path.join(phrenDir, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    tmpCleanup();
  });

  it("resolveActiveProfile prefers the persisted machine alias over the raw hostname", () => {
    persistMachineName("alias-box");
    fs.writeFileSync(
      path.join(phrenDir, "machines.yaml"),
      `alias-box: work\n${os.hostname()}: personal\n`,
    );

    const result = resolveActiveProfile(phrenDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe("work");
  });

  it("resolveActiveProfile falls back to the raw hostname when an alias is persisted but not mapped", () => {
    persistMachineName("alias-box");
    fs.writeFileSync(
      path.join(phrenDir, "machines.yaml"),
      `${defaultMachineName()}: work\n`,
    );

    const result = resolveActiveProfile(phrenDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe("work");
    expect(describeProfileMapping(phrenDir)).toEqual({ machine: "alias-box", mapped: true });
  });

  it("warns once when choosing between unmapped profiles without changing selection", () => {
    persistMachineName("unmapped-box");
    vi.stubEnv("PHREN_QUIET", "0");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const first = resolveActiveProfile(phrenDir);
    expect(first).toEqual({ ok: true, data: "personal" });
    expect(resolveActiveProfile(phrenDir)).toEqual(first);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0][0]).toContain("phren profile switch personal");
    expect(describeProfileMapping(phrenDir)).toEqual({ machine: "unmapped-box", mapped: false, assumed: "personal" });
  });

  it("does not warn for explicit selection, quiet mode, or a sole profile", () => {
    persistMachineName("unmapped-box");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("PHREN_QUIET", "0");
    expect(resolveActiveProfile(phrenDir, "work")).toEqual({ ok: true, data: "work" });
    vi.stubEnv("PHREN_QUIET", "1");
    expect(resolveActiveProfile(phrenDir)).toEqual({ ok: true, data: "personal" });
    vi.stubEnv("PHREN_QUIET", "0");
    fs.unlinkSync(path.join(phrenDir, "profiles", "work.yaml"));
    expect(resolveActiveProfile(phrenDir)).toEqual({ ok: true, data: "personal" });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("updateMachinesYaml keeps an existing mapping during passive refresh", () => {
    persistMachineName("alias-box");
    fs.writeFileSync(
      path.join(phrenDir, "machines.yaml"),
      "# Maps machines to profiles\nalias-box: work\n",
    );

    updateMachinesYaml(phrenDir);

    expect(fs.readFileSync(path.join(phrenDir, "machines.yaml"), "utf8")).toContain("alias-box: work");
  });

  it("updateMachinesYaml remaps an existing machine when profile is explicit", () => {
    fs.writeFileSync(
      path.join(phrenDir, "machines.yaml"),
      "# Maps machines to profiles\nalias-box: personal\n",
    );

    updateMachinesYaml(phrenDir, "alias-box", "work");

    const content = fs.readFileSync(path.join(phrenDir, "machines.yaml"), "utf8");
    expect(content).toContain("alias-box: work");
    expect(content.startsWith("# Maps machines to profiles")).toBe(true);
  });
});
