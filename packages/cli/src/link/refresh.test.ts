import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { writeInstallPreferences } from "../init/preferences.js";
import { writeProjectConfig } from "../project-config.js";
import { syncScopeSkillsToDir } from "../skill/files.js";
import { refreshLinkedContext } from "./refresh.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const tmp = makeTempDir("phren-refresh-");
  cleanups.push(tmp.cleanup);
  const store = path.join(tmp.path, "store");
  const repo = path.join(tmp.path, "repo");
  writeFile(path.join(store, "demo", "CLAUDE.md"), "# Updated project instructions\n");
  writeFile(path.join(store, "profiles", "dev.yaml"), "projects:\n  - global\n  - demo\n");
  writeInstallPreferences(store, { installSkillLinks: false }); // No home integration in this fixture.
  writeProjectConfig(store, "demo", { ownership: "phren-managed", sourcePath: repo });
  writeFile(path.join(repo, "AGENTS.md"), "# Old\n<!-- phren:generated-agents -->\n");
  return { store, repo };
}

describe("refreshing existing instruction and skill destinations", () => {
  it("refreshes generated AGENTS and skill mirrors after skills are added or deleted", () => {
    const { store, repo } = fixture();
    const skillsDir = path.join(repo, ".claude", "skills");
    const oldSkill = path.join(store, "demo", "skills", "old.md");
    writeFile(oldSkill, "---\nname: old\ndescription: obsolete\n---\nold\n");
    syncScopeSkillsToDir(store, "demo", skillsDir);
    fs.unlinkSync(oldSkill);
    writeFile(path.join(store, "global", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\nUse the checklist.\n");
    writeFile(path.join(store, "global", "skills", "review", "checklist.md"), "Check tests.\n");
    refreshLinkedContext(store, "dev");
    const agents = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("Updated project instructions");
    expect(agents).toContain("review");
    expect(fs.existsSync(path.join(skillsDir, "old.md"))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, "review", "checklist.md"), "utf8")).toBe("Check tests.\n");
  });

  it("preserves user-owned instructions and does not create integrations that are absent", () => {
    const { store, repo } = fixture();
    writeFile(path.join(repo, "AGENTS.md"), "# My own instructions\n");
    refreshLinkedContext(store, "dev");
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe("# My own instructions\n");
    expect(fs.existsSync(path.join(repo, ".claude"))).toBe(false);
  });

  it("respects ownership and the assisted preset", () => {
    const { store, repo } = fixture();
    const agents = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    writeProjectConfig(store, "demo", { ownership: "detached" });
    refreshLinkedContext(store, "dev");
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe(agents);
    writeProjectConfig(store, "demo", { ownership: "phren-managed" });
    writeInstallPreferences(store, { managementPreset: "assisted" });
    refreshLinkedContext(store, "dev");
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe(agents);
  });
});
