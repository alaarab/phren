/**
 * Permission regression tests for everything phren writes that can hold
 * secrets or verbatim knowledge-base content.
 *
 * These exist because the modes were wrong in a way that no functional test
 * could ever catch: `~/.phren/.runtime` shipped at 0755 on real installs (the
 * `mode: 0o700` in auth/profiles.ts was a no-op because `runtimeFile()` had
 * already created the directory without a mode), and the credential file was
 * written at the umask default and only chmod-ed to 0600 *after* the rename.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  atomicWriteText,
  ensurePrivateDir,
  runtimeFile,
  sessionMarker,
} from "../phren-paths.js";
import { authProfilesPath, upsertApiKeyProfile } from "../auth/profiles.js";
import { makeTempDir } from "../test-helpers.js";

const posixOnly = process.platform === "win32" ? it.skip : it;

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("private file and directory modes", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("private-modes-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  // ── ensurePrivateDir ──────────────────────────────────────────────────────

  posixOnly("creates a new directory at 0700", () => {
    const dir = ensurePrivateDir(path.join(tmp.path, "fresh"));
    expect(mode(dir)).toBe(0o700);
  });

  posixOnly("tightens an existing world-readable directory", () => {
    const dir = path.join(tmp.path, "preexisting");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    expect(mode(dir)).toBe(0o755);

    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  posixOnly("tightens a group-readable directory too", () => {
    const dir = path.join(tmp.path, "group-readable");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o750);

    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  posixOnly("leaves an already-private directory alone", () => {
    const dir = path.join(tmp.path, "already-private");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);

    ensurePrivateDir(dir);
    // Narrower than 0700 is fine — ensurePrivateDir only ever narrows.
    expect(mode(dir)).toBe(0o500);
  });

  posixOnly("does not widen the parent directory", () => {
    const parent = path.join(tmp.path, "parent");
    fs.mkdirSync(parent, { recursive: true });
    fs.chmodSync(parent, 0o755);

    ensurePrivateDir(path.join(parent, "child"));
    expect(mode(parent)).toBe(0o755);
    expect(mode(path.join(parent, "child"))).toBe(0o700);
  });

  it("is idempotent", () => {
    const dir = path.join(tmp.path, "idem");
    ensurePrivateDir(dir);
    expect(() => ensurePrivateDir(dir)).not.toThrow();
    expect(fs.existsSync(dir)).toBe(true);
  });

  // ── atomicWriteText mode ──────────────────────────────────────────────────

  posixOnly("atomicWriteText applies the requested mode to the final file", () => {
    const file = path.join(tmp.path, "secret.json");
    atomicWriteText(file, '{"k":"v"}\n', { mode: 0o600 });
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe('{"k":"v"}\n');
  });

  posixOnly("atomicWriteText mode beats a permissive umask", () => {
    const prior = process.umask(0o000);
    try {
      const file = path.join(tmp.path, "umask-proof.json");
      atomicWriteText(file, "x", { mode: 0o600 });
      expect(mode(file)).toBe(0o600);
    } finally {
      process.umask(prior);
    }
  });

  posixOnly("atomicWriteText leaves no readable temp file behind", () => {
    const file = path.join(tmp.path, "no-leftovers.json");
    atomicWriteText(file, "x", { mode: 0o600 });
    const strays = fs.readdirSync(tmp.path).filter((n) => n.includes(".tmp-"));
    expect(strays).toEqual([]);
  });

  it("atomicWriteText without a mode still writes the content", () => {
    const file = path.join(tmp.path, "plain.txt");
    atomicWriteText(file, "hello\n");
    expect(fs.readFileSync(file, "utf8")).toBe("hello\n");
  });

  // ── runtime / session directories ─────────────────────────────────────────

  posixOnly("runtimeFile creates .runtime at 0700", () => {
    const store = path.join(tmp.path, "store-a");
    fs.mkdirSync(store, { recursive: true });
    runtimeFile(store, "debug.log");
    expect(mode(path.join(store, ".runtime"))).toBe(0o700);
  });

  posixOnly("runtimeFile repairs a pre-existing 0755 .runtime", () => {
    const store = path.join(tmp.path, "store-b");
    const runtime = path.join(store, ".runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.chmodSync(runtime, 0o755);

    runtimeFile(store, "debug.log");
    expect(mode(runtime)).toBe(0o700);
  });

  posixOnly("sessionMarker creates .sessions at 0700", () => {
    const store = path.join(tmp.path, "store-c");
    fs.mkdirSync(store, { recursive: true });
    sessionMarker(store, "marker");
    expect(mode(path.join(store, ".sessions"))).toBe(0o700);
  });

  // ── credential store ──────────────────────────────────────────────────────

  describe("auth profile store", () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    beforeEach(() => {
      process.env.HOME = tmp.path;
      process.env.USERPROFILE = tmp.path;
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    });

    posixOnly("writes credentials at 0600 inside a 0700 directory", () => {
      upsertApiKeyProfile("openai", "sk-not-a-real-key");
      const file = authProfilesPath();
      expect(mode(file)).toBe(0o600);
      expect(mode(path.dirname(file))).toBe(0o700);
    });

    posixOnly("hardens a .runtime directory that ordinary session writes already created at 0755", () => {
      // This is the real-world sequence: any session writes a runtime file
      // first, so mkdirSync's mode argument never applied to the credential
      // directory and it stayed world-listable.
      const runtime = path.join(tmp.path, ".phren", ".runtime");
      fs.mkdirSync(runtime, { recursive: true });
      fs.chmodSync(runtime, 0o755);

      upsertApiKeyProfile("anthropic", "sk-ant-not-a-real-key");
      expect(mode(runtime)).toBe(0o700);
      expect(mode(authProfilesPath())).toBe(0o600);
    });

    posixOnly("stays at 0600 across rewrites", () => {
      upsertApiKeyProfile("openai", "sk-first");
      upsertApiKeyProfile("openai", "sk-second");
      expect(mode(authProfilesPath())).toBe(0o600);
    });
  });
});
