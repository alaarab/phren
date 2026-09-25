import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setMachineProfile,
} from "../data/access.js";
import { PhrenError } from "../shared.js";
import { grantAdmin, makeTempDir, } from "../test-helpers.js";
import * as path from "path";
import * as fs from "fs";

const PROJECT = "conctest";

let tmpDir: string;
let projectDir: string;
let tmpCleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-conc-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  delete process.env.PHREN_FILE_LOCK_MAX_WAIT_MS;
  delete process.env.PHREN_FILE_LOCK_POLL_MS;
  delete process.env.PHREN_ACTOR;
  tmpCleanup();
});

("concurrent write safety - cross-process", () => {
});

describe("concurrent write safety - machines.yaml", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "orig-machine: personal\n");
    fs.writeFileSync(
      path.join(tmpDir, "profiles", "personal.yaml"),
      "name: personal\nprojects:\n  - conctest\n"
    );
  });

  it("machine lock timeout returns proper error", () => {
    const lockPath = path.join(tmpDir, "machines.yaml.lock");
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);

    process.env.PHREN_FILE_LOCK_MAX_WAIT_MS = "100";
    process.env.PHREN_FILE_LOCK_POLL_MS = "20";

    const msg = setMachineProfile(tmpDir, "blocked-machine", "personal");
    fs.unlinkSync(lockPath);

    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(PhrenError.LOCK_TIMEOUT);
  });
});
