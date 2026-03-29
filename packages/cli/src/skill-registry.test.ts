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
});
