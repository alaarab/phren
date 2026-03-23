import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import { permissionDeniedError } from "../governance/rbac.js";

function writeAccessControl(phrenPath: string, data: Record<string, unknown>): void {
  const dir = path.join(phrenPath, ".config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "access-control.json"), JSON.stringify(data));
}

function writeProjectYaml(phrenPath: string, project: string, yaml: string): void {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "phren.project.yaml"), yaml);
}

let tmp: { path: string; cleanup: () => void };
let phrenPath: string;
const origActor = process.env.PHREN_ACTOR;

beforeEach(() => {
  tmp = makeTempDir("rbac-test-");
  phrenPath = tmp.path;
  initTestPhrenRoot(phrenPath);
  delete process.env.PHREN_ACTOR;
});

afterEach(() => {
  if (origActor !== undefined) {
    process.env.PHREN_ACTOR = origActor;
  } else {
    delete process.env.PHREN_ACTOR;
  }
  tmp.cleanup();
});

// ── Open mode (no access-control.json) ───────────────────────────────────────

describe("open mode (no access-control.json)", () => {
  it("allows all actions when no ACL file exists", () => {
    expect(permissionDeniedError(phrenPath, "add_finding")).toBeNull();
    expect(permissionDeniedError(phrenPath, "manage_config")).toBeNull();
  });

  it("allows all actions even with PHREN_ACTOR set when no ACL exists", () => {
    process.env.PHREN_ACTOR = "alice";
    expect(permissionDeniedError(phrenPath, "add_finding")).toBeNull();
    expect(permissionDeniedError(phrenPath, "manage_config")).toBeNull();
  });
});

// ── readGlobalAccessControl edge cases ───────────────────────────────────────

describe("readGlobalAccessControl edge cases", () => {
  it("treats invalid JSON as open mode", () => {
    const dir = path.join(phrenPath, ".config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "access-control.json"), "NOT JSON");
    expect(permissionDeniedError(phrenPath, "add_finding")).toBeNull();
  });

  it("treats array JSON as open mode", () => {
    const dir = path.join(phrenPath, ".config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "access-control.json"), "[]");
    expect(permissionDeniedError(phrenPath, "add_finding")).toBeNull();
  });
});

// ── Admin role ───────────────────────────────────────────────────────────────

describe("admin role", () => {
  beforeEach(() => {
    writeAccessControl(phrenPath, {
      admins: ["admin-user"],
      contributors: ["contrib-user"],
      readers: ["reader-user"],
    });
  });

  it("allows admins to perform all actions", () => {
    process.env.PHREN_ACTOR = "admin-user";
    expect(permissionDeniedError(phrenPath, "add_finding")).toBeNull();
    expect(permissionDeniedError(phrenPath, "manage_config")).toBeNull();
    expect(permissionDeniedError(phrenPath, "remove_task")).toBeNull();
  });
});

// ── Contributor role ─────────────────────────────────────────────────────────

describe("contributor role", () => {
  beforeEach(() => {
    writeAccessControl(phrenPath, {
      admins: ["admin-user"],
      contributors: ["contrib-user"],
      readers: ["reader-user"],
    });
  });

  it("allows contributors to add findings and tasks", () => {
    process.env.PHREN_ACTOR = "contrib-user";
    expect(permissionDeniedError(phrenPath, "add_finding")).toBeNull();
    expect(permissionDeniedError(phrenPath, "add_task")).toBeNull();
    expect(permissionDeniedError(phrenPath, "complete_task")).toBeNull();
    expect(permissionDeniedError(phrenPath, "edit_finding")).toBeNull();
  });

  it("blocks contributors from admin-only actions", () => {
    process.env.PHREN_ACTOR = "contrib-user";
    const err = permissionDeniedError(phrenPath, "manage_config");
    expect(err).not.toBeNull();
    expect(err).toContain("contributor");
    expect(err).toContain("manage_config");
  });
});

// ── Reader role ──────────────────────────────────────────────────────────────

describe("reader role", () => {
  beforeEach(() => {
    writeAccessControl(phrenPath, {
      admins: ["admin-user"],
      contributors: ["contrib-user"],
      readers: ["reader-user"],
    });
  });

  it("blocks readers from all mutating actions", () => {
    process.env.PHREN_ACTOR = "reader-user";
    expect(permissionDeniedError(phrenPath, "add_finding")).not.toBeNull();
    expect(permissionDeniedError(phrenPath, "remove_finding")).not.toBeNull();
    expect(permissionDeniedError(phrenPath, "add_task")).not.toBeNull();
    expect(permissionDeniedError(phrenPath, "manage_config")).not.toBeNull();
  });
});

// ── Unknown actor ────────────────────────────────────────────────────────────

describe("unknown actor", () => {
  it("denies access to unknown actors when ACL is configured", () => {
    writeAccessControl(phrenPath, {
      admins: ["admin-user"],
      contributors: ["contrib-user"],
    });
    process.env.PHREN_ACTOR = "stranger";
    const err = permissionDeniedError(phrenPath, "add_finding");
    expect(err).not.toBeNull();
    expect(err).toContain("stranger");
    expect(err).toContain("not listed");
  });
});

// ── No PHREN_ACTOR set ───────────────────────────────────────────────────────

describe("no PHREN_ACTOR set", () => {
  it("denies access when ACL is configured but PHREN_ACTOR is unset", () => {
    writeAccessControl(phrenPath, {
      admins: ["admin-user"],
    });
    delete process.env.PHREN_ACTOR;
    const err = permissionDeniedError(phrenPath, "add_finding");
    expect(err).not.toBeNull();
    expect(err).toContain("PHREN_ACTOR");
  });

  it("allows access when ACL has empty role lists (open mode)", () => {
    writeAccessControl(phrenPath, {
      admins: [],
      contributors: [],
      readers: [],
    });
    delete process.env.PHREN_ACTOR;
    expect(permissionDeniedError(phrenPath, "add_finding")).toBeNull();
  });
});

// ── mergeAccessControl (project ACL overrides global) ────────────────────────

describe("project-level ACL override", () => {
  it("merges project admins with global admins", () => {
    writeAccessControl(phrenPath, {
      admins: ["global-admin"],
      contributors: [],
      readers: [],
    });
    writeProjectYaml(phrenPath, "myproject", [
      "access:",
      "  admins:",
      "    - project-admin",
    ].join("\n"));

    process.env.PHREN_ACTOR = "project-admin";
    expect(permissionDeniedError(phrenPath, "manage_config", "myproject")).toBeNull();

    process.env.PHREN_ACTOR = "global-admin";
    expect(permissionDeniedError(phrenPath, "manage_config", "myproject")).toBeNull();
  });

  it("project contributors can write even if not in global list", () => {
    writeAccessControl(phrenPath, {
      admins: ["admin"],
      contributors: [],
      readers: [],
    });
    writeProjectYaml(phrenPath, "myproject", [
      "access:",
      "  contributors:",
      "    - project-contrib",
    ].join("\n"));

    process.env.PHREN_ACTOR = "project-contrib";
    expect(permissionDeniedError(phrenPath, "add_finding", "myproject")).toBeNull();
    // Still blocked from admin-only
    expect(permissionDeniedError(phrenPath, "manage_config", "myproject")).not.toBeNull();
  });
});
