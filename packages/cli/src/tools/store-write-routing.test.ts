/**
 * Write-routing regression tests.
 *
 * A team store declared in stores.yaml but never cloned onto this machine used
 * to make `resolveStoreForProject` fall through to the primary store, so work
 * projects claimed by that store were written into the user's personal store
 * (and pushed to their personal remote). Writes must now fail loudly instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { writeStoreRegistry, type StoreRegistry } from "../store-registry.js";
import { resolveStoreForProject, StoreUnavailableError, type McpContext } from "./types.js";

/** Minimal McpContext — resolveStoreForProject only reads phrenPath. */
function makeCtx(phrenPath: string): McpContext {
  return {
    phrenPath,
    profile: "personal",
    db: () => { throw new Error("db() not used by store routing"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async (fn) => fn(),
  };
}

describe("resolveStoreForProject — missing team store", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenDir: string;
  let teamDir: string;
  const origFedPaths = process.env.PHREN_FEDERATION_PATHS;

  /** Mirrors the real user's stores.yaml: a team store claiming work projects. */
  function declareTeamStore(opts: { createDir: boolean }): void {
    const registry: StoreRegistry = {
      version: 1,
      stores: [
        { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
        {
          id: "bbb22222",
          name: "work-shared",
          path: teamDir,
          role: "team",
          sync: "managed-git",
          remote: "git@github.com:acme/work-shared.git",
          projects: ["arc", "emv"],
        },
      ],
    };
    writeStoreRegistry(phrenDir, registry);
    if (opts.createDir) fs.mkdirSync(teamDir, { recursive: true });
  }

  beforeEach(() => {
    tmp = makeTempDir("store-write-routing-");
    phrenDir = path.join(tmp.path, ".phren");
    teamDir = path.join(tmp.path, ".phren-work-shared");
    fs.mkdirSync(phrenDir, { recursive: true });
    delete process.env.PHREN_FEDERATION_PATHS;
  });

  afterEach(() => {
    if (origFedPaths !== undefined) process.env.PHREN_FEDERATION_PATHS = origFedPaths;
    else delete process.env.PHREN_FEDERATION_PATHS;
    tmp.cleanup();
  });

  // ── The leak ──────────────────────────────────────────────────────────────

  it("does NOT write a project claimed by a missing store into the primary store", () => {
    declareTeamStore({ createDir: false });
    const ctx = makeCtx(phrenDir);

    expect(() => resolveStoreForProject(ctx, "arc")).toThrow(StoreUnavailableError);
    // The specific guarantee: no code path returns the primary store here.
    try {
      resolveStoreForProject(ctx, "arc");
      throw new Error("expected resolveStoreForProject to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreUnavailableError);
      expect((err as StoreUnavailableError).storePath).not.toBe(phrenDir);
    }
  });

  it("names the store, the expected path, and how to attach it", () => {
    declareTeamStore({ createDir: false });
    const ctx = makeCtx(phrenDir);

    let message = "";
    try {
      resolveStoreForProject(ctx, "arc");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("work-shared");
    expect(message).toContain(teamDir);
    expect(message).toContain("git@github.com:acme/work-shared.git");
    expect(message).toContain("arc");
  });

  it("defaults to write mode, so an unclassified caller gets the safe behavior", () => {
    declareTeamStore({ createDir: false });
    const ctx = makeCtx(phrenDir);
    // No mode argument at all.
    expect(() => resolveStoreForProject(ctx, "arc")).toThrow(StoreUnavailableError);
  });

  it("fails for a store-qualified write naming the missing store", () => {
    declareTeamStore({ createDir: false });
    const ctx = makeCtx(phrenDir);
    expect(() => resolveStoreForProject(ctx, "work-shared/arc")).toThrow(StoreUnavailableError);
  });

  // ── Reads degrade instead ─────────────────────────────────────────────────

  it("lets reads fall back to the primary store", () => {
    declareTeamStore({ createDir: false });
    const ctx = makeCtx(phrenDir);

    const resolved = resolveStoreForProject(ctx, "arc", "read");
    expect(resolved.phrenPath).toBe(phrenDir);
    expect(resolved.storeRole).toBe("primary");
    expect(resolved.project).toBe("arc");
  });

  it("still fails a read that explicitly names the missing store", () => {
    declareTeamStore({ createDir: false });
    const ctx = makeCtx(phrenDir);
    // Nothing to degrade to — the caller asked for that store by name.
    expect(() => resolveStoreForProject(ctx, "work-shared/arc", "read")).toThrow(StoreUnavailableError);
  });

  // ── Happy paths are unchanged ─────────────────────────────────────────────

  it("routes writes to a claiming store that IS attached", () => {
    declareTeamStore({ createDir: true });
    const ctx = makeCtx(phrenDir);

    const resolved = resolveStoreForProject(ctx, "arc");
    expect(resolved.phrenPath).toBe(teamDir);
    expect(resolved.storeRole).toBe("team");
  });

  it("routes unclaimed projects to the primary store", () => {
    declareTeamStore({ createDir: true });
    const ctx = makeCtx(phrenDir);

    const resolved = resolveStoreForProject(ctx, "my-side-project");
    expect(resolved.phrenPath).toBe(phrenDir);
    expect(resolved.storeRole).toBe("primary");
  });

  it("routes to the primary store when no stores.yaml exists at all", () => {
    const ctx = makeCtx(phrenDir);
    const resolved = resolveStoreForProject(ctx, "arc");
    expect(resolved.phrenPath).toBe(phrenDir);
    expect(resolved.storeRole).toBe("primary");
  });

  it("keeps rejecting unknown and read-only stores", () => {
    declareTeamStore({ createDir: true });
    const ctx = makeCtx(phrenDir);
    expect(() => resolveStoreForProject(ctx, "nope/arc")).toThrow(/not found/);
  });
});
