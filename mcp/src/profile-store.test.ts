import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { defaultMachineName, persistMachineName } from "./machine-identity.js";
import { updateMachinesYaml } from "./init-setup.js";
import { resolveActiveProfile } from "./profile-store.js";

describe("machine identity and profile resolution", () => {
  let tmpRoot: string;
  let cortexDir: string;
  let homeDir: string;
  let tmpCleanup: () => void;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-profile-store-test-"));
    cortexDir = path.join(tmpRoot, ".cortex");
    homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(path.join(cortexDir, "profiles"), { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.writeFileSync(path.join(cortexDir, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - global\n");
    fs.writeFileSync(path.join(cortexDir, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    tmpCleanup();
  });

  it("resolveActiveProfile prefers the persisted machine alias over the raw hostname", () => {
    persistMachineName("alias-box");
    fs.writeFileSync(
      path.join(cortexDir, "machines.yaml"),
      `alias-box: work\n${os.hostname()}: personal\n`,
    );

    const result = resolveActiveProfile(cortexDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe("work");
  });

  it("resolveActiveProfile falls back to the raw hostname when an alias is persisted but not mapped", () => {
    persistMachineName("alias-box");
    fs.writeFileSync(
      path.join(cortexDir, "machines.yaml"),
      `${defaultMachineName()}: work\n`,
    );

    const result = resolveActiveProfile(cortexDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe("work");
  });

  it("updateMachinesYaml keeps an existing mapping during passive refresh", () => {
    persistMachineName("alias-box");
    fs.writeFileSync(
      path.join(cortexDir, "machines.yaml"),
      "# Maps machines to profiles\nalias-box: work\n",
    );

    updateMachinesYaml(cortexDir);

    expect(fs.readFileSync(path.join(cortexDir, "machines.yaml"), "utf8")).toContain("alias-box: work");
  });

  it("updateMachinesYaml remaps an existing machine when profile is explicit", () => {
    fs.writeFileSync(
      path.join(cortexDir, "machines.yaml"),
      "# Maps machines to profiles\nalias-box: personal\n",
    );

    updateMachinesYaml(cortexDir, "alias-box", "work");

    const content = fs.readFileSync(path.join(cortexDir, "machines.yaml"), "utf8");
    expect(content).toContain("alias-box: work");
    expect(content.startsWith("# Maps machines to profiles")).toBe(true);
  });
});
