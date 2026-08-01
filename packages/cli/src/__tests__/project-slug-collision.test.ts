/**
 * Project slug determinism / collision regression tests.
 *
 * `/Users/u/Projects/Max4LivePlugins` was registered once as `max4liveplugins`
 * and later again as `max4live-plugins`, producing two project directories with
 * disjoint findings. The second had no phren.project.yaml, no CLAUDE.md and no
 * topic-config.json, so it looked half-created while holding real data.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot, suppressOutput } from "../test-helpers.js";
import {
  canonicalProjectKey,
  projectSlugFromPath,
  findProjectNamesByCanonicalKey,
} from "../phren-paths.js";
import { bootstrapFromExisting } from "../init/setup.js";
import { writeProjectConfig } from "../project-config.js";

describe("projectSlugFromPath", () => {
  it("is deterministic for the same directory", () => {
    expect(projectSlugFromPath("/Users/u/Projects/Max4LivePlugins")).toBe("max4liveplugins");
    expect(projectSlugFromPath("/Users/u/Projects/Max4LivePlugins/")).toBe("max4liveplugins");
  });

  it("collapses separator runs instead of emitting doubled hyphens", () => {
    expect(projectSlugFromPath("/x/My..App")).toBe("my-app");
    expect(projectSlugFromPath("/x/My App")).toBe("my-app");
    expect(projectSlugFromPath("/x/My   App")).toBe("my-app");
  });

  it("trims leading and trailing separators", () => {
    expect(projectSlugFromPath("/x/.hidden-project")).toBe("hidden-project");
    expect(projectSlugFromPath("/x/project.")).toBe("project");
  });

  it("preserves hyphens and underscores that were already there", () => {
    expect(projectSlugFromPath("/x/my-app")).toBe("my-app");
    expect(projectSlugFromPath("/x/my_app")).toBe("my_app");
  });
});

describe("canonicalProjectKey", () => {
  it("maps the two spellings of the same repo to one key", () => {
    expect(canonicalProjectKey("max4liveplugins")).toBe("max4liveplugins");
    expect(canonicalProjectKey("max4live-plugins")).toBe("max4liveplugins");
    expect(canonicalProjectKey("Max4Live_Plugins")).toBe("max4liveplugins");
  });

  it("keeps genuinely different names apart", () => {
    expect(canonicalProjectKey("phren-api")).not.toBe(canonicalProjectKey("phren-web"));
  });
});

describe("findProjectNamesByCanonicalKey", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenDir: string;

  beforeEach(() => {
    tmp = makeTempDir("slug-collision-");
    phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  it("finds a hyphenated sibling of an unhyphenated project", () => {
    fs.mkdirSync(path.join(phrenDir, "max4liveplugins"));
    expect(findProjectNamesByCanonicalKey(phrenDir, "max4live-plugins")).toEqual(["max4liveplugins"]);
  });

  it("returns the exact match first when both spellings exist", () => {
    fs.mkdirSync(path.join(phrenDir, "max4liveplugins"));
    fs.mkdirSync(path.join(phrenDir, "max4live-plugins"));
    expect(findProjectNamesByCanonicalKey(phrenDir, "max4live-plugins")[0]).toBe("max4live-plugins");
  });

  it("returns nothing for an unrelated name", () => {
    fs.mkdirSync(path.join(phrenDir, "max4liveplugins"));
    expect(findProjectNamesByCanonicalKey(phrenDir, "some-other-repo")).toEqual([]);
  });
});

describe("bootstrapFromExisting — duplicate avoidance", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenDir: string;
  let repo: string;

  beforeEach(() => {
    tmp = makeTempDir("bootstrap-dedupe-");
    phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });
    initTestPhrenRoot(phrenDir);
    repo = path.join(tmp.path, "Max4LivePlugins");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  const bootstrap = (target: string) =>
    suppressOutput(async () => bootstrapFromExisting(phrenDir, target));

  it("reuses the existing project when the same path is added twice", async () => {
    const first = await bootstrap(repo);
    const second = await bootstrap(repo);
    expect(second.project).toBe(first.project);
    expect(fs.readdirSync(phrenDir).filter((d) => d.toLowerCase().includes("max4live"))).toHaveLength(1);
  });

  it("reuses a project registered under the other spelling of the same slug", async () => {
    // Simulate the pre-existing `max4live-plugins` directory from the real
    // store — created by a manual `add_project` call, with no sourcePath.
    fs.mkdirSync(path.join(phrenDir, "max4live-plugins"), { recursive: true });

    const result = await bootstrap(repo);
    expect(result.project).toBe("max4live-plugins");
    expect(fs.existsSync(path.join(phrenDir, "max4liveplugins"))).toBe(false);
  });

  it("keeps two projects apart when they slug alike but point at different repos", async () => {
    const other = path.join(tmp.path, "other", "max4live-plugins");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    fs.mkdirSync(path.join(phrenDir, "max4live-plugins"), { recursive: true });
    writeProjectConfig(phrenDir, "max4live-plugins", { sourcePath: other });

    const result = await bootstrap(repo);
    expect(result.project).toBe("max4liveplugins");
    expect(fs.existsSync(path.join(phrenDir, "max4live-plugins"))).toBe(true);
  });

  // ── Worktrees ─────────────────────────────────────────────────────────────

  it("attributes an agent worktree to the parent repo instead of a new project", async () => {
    const parent = await bootstrap(repo);

    const worktree = path.join(repo, ".claude", "worktrees", "gracious-napier-332a40");
    fs.mkdirSync(worktree, { recursive: true });
    const result = await bootstrap(worktree);

    expect(result.project).toBe(parent.project);
    expect(fs.existsSync(path.join(phrenDir, "gracious-napier-332a40"))).toBe(false);
  });

  it("attributes a worktree even when the parent was never registered", async () => {
    const worktree = path.join(repo, ".claude", "worktrees", "gracious-napier-332a40");
    fs.mkdirSync(worktree, { recursive: true });

    const result = await bootstrap(worktree);
    expect(result.project).toBe("max4liveplugins");
    expect(fs.existsSync(path.join(phrenDir, "gracious-napier-332a40"))).toBe(false);
  });
});
