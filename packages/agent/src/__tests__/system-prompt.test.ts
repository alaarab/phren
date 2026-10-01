import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, buildEnvironmentBlock, buildToolSection } from "../system-prompt.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sysprompt-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repoOnBranch(branch: string): string {
  const dir = tmp();
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", branch);
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

describe("environment block", () => {
  it("has cwd, platform, shell, date and the permission mode", () => {
    const dir = tmp();
    const block = buildEnvironmentBlock(dir, "auto-confirm");
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(block).toContain("## Environment");
    expect(block).toContain(`Working directory: ${dir}`);
    expect(block).toContain(`Today's date: ${date}`);
    expect(block).toContain(process.platform);
    expect(block).toContain("Shell:");
    expect(block).toContain("Permission mode: auto-confirm");
    expect(block).not.toMatch(/\d\d:\d\d/);
  });

  it("names the branch inside a git repo", () => {
    const block = buildEnvironmentBlock(repoOnBranch("feature-x"));
    expect(block).toContain("Git repository: yes, branch feature-x");
  });

  it("says no repo outside one, without failing", () => {
    const block = buildEnvironmentBlock(tmp());
    expect(block).toContain("Git repository: no");
    expect(block).not.toContain("branch");
  });

  it("is in the system prompt, and a prebuilt block is used as given", () => {
    const dir = tmp();
    const prompt = buildSystemPrompt("", null, undefined, undefined, { environment: buildEnvironmentBlock(dir) });
    expect(prompt).toContain(`Working directory: ${dir}`);
    expect(buildSystemPrompt("", null, undefined, undefined, { environment: "## Environment\n- fixed" })).toContain("- fixed");
  });
});

describe("tool section", () => {
  it("lists only registered tools", () => {
    const prompt = buildSystemPrompt("", null, undefined, undefined, {
      toolNames: ["read_file", "edit_file", "multi_edit", "glob", "shell", "spawn_agent"],
    });
    for (const name of ["read_file", "edit_file", "multi_edit", "glob", "shell", "spawn_agent"]) {
      expect(prompt).toContain(`\`${name}\``);
    }
    for (const name of ["phren_search", "apply_patch", "web_fetch", "git_commit"]) {
      expect(prompt).not.toContain(`\`${name}\``);
    }
    expect(prompt).toContain("Edit tools:");
  });

  it("drops the memory steps when there are no memory tools, and keeps them when there are", () => {
    const without = buildSystemPrompt("", null, undefined, undefined, { toolNames: ["read_file"] });
    expect(without).not.toContain("phren_search");
    expect(without).not.toContain("phren_add_finding");
    const withMemory = buildSystemPrompt("", null, undefined, undefined, { toolNames: ["phren_search", "phren_add_finding"] });
    expect(withMemory).toContain("Search memory first");
    expect(withMemory).toContain("Memory: `phren_search`, `phren_add_finding`");
  });

  it("summarizes MCP tools per server instead of listing them", () => {
    const section = buildToolSection(
      ["read_file", "mcp_github_create_issue", "mcp_github_list_prs", "mcp_my_db_query"],
      ["github", "my_db"],
    );
    expect(section).toContain("MCP: github (2), my_db (1)");
    expect(section).not.toContain("create_issue");
    expect(section).not.toContain("mcp_my_db_query");
  });
});

describe("workflow", () => {
  it("names only registered tools", () => {
    const prompt = buildSystemPrompt("", null, undefined, undefined, { toolNames: ["read_file", "write_file"] });
    expect(prompt).not.toContain("`git_diff`");
    expect(prompt).not.toContain("`shell`");
    expect(prompt).not.toContain("`edit_file`");
    expect(prompt).toContain("`write_file`");
  });
});
