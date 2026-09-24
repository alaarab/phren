import { describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, writeFile } from "./test-helpers.js";
import { buildSkillManifest } from "./skill/registry.js";

describe("skill-registry", () => {
  it("resolves project-local skills over inherited global skills", () => {
    const tmp = makeTempDir("skill-registry-");
    try {
      writeFile(
        path.join(tmp.path, "global", "skills", "humanize.md"),
        "---\nname: humanize\ndescription: global\ncommand: /humanize\n---\nbody\n",
      );
      writeFile(
        path.join(tmp.path, "demo", "skills", "humanize.md"),
        "---\nname: humanize\ndescription: project\ncommand: /humanize-local\n---\nbody\n",
      );
      writeFile(
        path.join(tmp.path, "demo", "skills", "verify.md"),
        "---\nname: verify\ndescription: verify\n---\nbody\n",
      );

      const manifest = buildSkillManifest(tmp.path, "", "demo", "/tmp/demo/.claude/skills");
      const humanize = manifest.skills.find((skill) => skill.name === "humanize");
      const verify = manifest.skills.find((skill) => skill.name === "verify");

      expect(humanize?.source).toBe("demo");
      expect(humanize?.command).toBe("/humanize-local");
      expect(humanize?.overrides).toHaveLength(1);
      expect(humanize?.overrides[0]?.source).toBe("global");
      expect(path.normalize(humanize?.mirrorTargets[0] || "")).toContain(path.normalize(".claude/skills"));
      expect(verify?.source).toBe("demo");
    } finally {
      tmp.cleanup();
    }
  });

  it("marks colliding commands as unregistered in the manifest", () => {
    const tmp = makeTempDir("skill-registry-");
    try {
      writeFile(
        path.join(tmp.path, "global", "skills", "humanize.md"),
        "---\nname: humanize\ndescription: global\ncommand: /shared\n---\nbody\n",
      );
      writeFile(
        path.join(tmp.path, "global", "skills", "verify.md"),
        "---\nname: verify\ndescription: verify\ncommand: /shared\n---\nbody\n",
      );

      const manifest = buildSkillManifest(tmp.path, "", "global", "/tmp/.claude/skills");
      expect(manifest.problems).toHaveLength(1);
      expect(manifest.problems[0]?.code).toBe("command-collision");
      expect(manifest.commands.filter((command) => command.command === "/shared" && !command.registered)).toHaveLength(2);
    } finally {
      tmp.cleanup();
    }
  });

  it("deduplicates aliases against the primary command without disabling it", () => {
    const tmp = makeTempDir("skill-registry-");
    try {
      writeFile(
        path.join(tmp.path, "global", "skills", "review.md"),
        "---\nname: review\ndescription: review\ncommand: Check\naliases: [check, /CHECK, inspect, /INSPECT]\n---\nbody\n",
      );

      const manifest = buildSkillManifest(tmp.path, "", "global");
      expect(manifest.problems).toEqual([]);
      expect(manifest.skills[0]?.commandRegistered).toBe(true);
      expect(manifest.skills[0]?.aliases).toEqual(["/inspect"]);
      expect(manifest.commands.map(({ command, registered }) => ({ command, registered }))).toEqual([
        { command: "/Check", registered: true },
        { command: "/inspect", registered: true },
      ]);
    } finally {
      tmp.cleanup();
    }
  });

  it("still rejects aliases shared by different skills and ignores disabled owners", () => {
    const tmp = makeTempDir("skill-registry-");
    try {
      writeFile(
        path.join(tmp.path, "global", "skills", "review.md"),
        "---\nname: review\ndescription: review\ncommand: /review\naliases: [REVIEW, inspect]\n---\nbody\n",
      );
      writeFile(
        path.join(tmp.path, "demo", "skills", "inspect.md"),
        "---\nname: inspect\ndescription: inspect\ncommand: /INSPECT\n---\nbody\n",
      );

      const manifest = buildSkillManifest(tmp.path, "", "demo");
      expect(manifest.problems).toHaveLength(1);
      expect(manifest.problems[0]?.skillIds).toEqual(["inspect", "review"]);
      expect(manifest.commands.filter((command) => !command.registered)).toHaveLength(2);
      expect(manifest.skills.find((skill) => skill.name === "review")?.commandRegistered).toBe(true);

      writeFile(path.join(tmp.path, ".config", "skill-preferences.json"), JSON.stringify({
        schemaVersion: 1, enabledSkills: { "demo:inspect": false },
      }));
      const refreshed = buildSkillManifest(tmp.path, "", "demo");
      expect(refreshed.problems).toEqual([]);
      expect(refreshed.commands.find((command) => command.command === "/inspect")?.registered).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });
});
