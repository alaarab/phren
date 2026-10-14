import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";

// Windows answers a create of a lock file another process is deleting with
// EPERM rather than EEXIST; stand in for that one write.
const fail = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSync = ((...args: Parameters<typeof actual.writeFileSync>) => {
    if (fail.code) throw Object.assign(new Error(`${fail.code}: operation not permitted, open`), { code: fail.code });
    return actual.writeFileSync(...args);
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

const { tryFileLock } = await import("./locks.js");

const platform = process.platform;
afterEach(() => {
  fail.code = undefined;
  Object.defineProperty(process, "platform", { value: platform });
});

describe("tryFileLock", () => {
  it("reports a lock Windows is still deleting as held, not as an error", () => {
    const tmp = makeTempDir("phren-trylock-");
    try {
      const lockFile = path.join(tmp.path, "index-rebuild.lock");
      fs.writeFileSync(lockFile, "being deleted");
      Object.defineProperty(process, "platform", { value: "win32" });
      fail.code = "EPERM";
      expect(tryFileLock(path.join(tmp.path, "index-rebuild"))).toBeNull();
      fs.unlinkSync(lockFile);
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(() => tryFileLock(path.join(tmp.path, "index-rebuild"))).toThrow(/EPERM/);
      fail.code = undefined;
      const release = tryFileLock(path.join(tmp.path, "index-rebuild"));
      expect(release).toBeTypeOf("function");
      release!();
    } finally {
      tmp.cleanup();
    }
  });

  it("surfaces a Windows permission error when no lock file exists", () => {
    const tmp = makeTempDir("phren-trylock-");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      fail.code = "EACCES";
      expect(() => tryFileLock(path.join(tmp.path, "index-rebuild"))).toThrow(/EACCES/);
    } finally {
      tmp.cleanup();
    }
  });
});
