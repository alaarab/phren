import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkPermission } from "../permissions/checker.js";
import { evaluateRules, loadPermissionRules, parseRuleList, emptyRules, type PermissionRules } from "../permissions/rules.js";
import { parseArgs } from "../config.js";
import type { PermissionConfig } from "../permissions/types.js";

const root = "/tmp/project";
const rules = (r: Partial<PermissionRules>): PermissionRules => ({ ...emptyRules(), ...r });
const check = (mode: PermissionConfig["mode"], r: Partial<PermissionRules>, tool: string, input: Record<string, unknown>) =>
  checkPermission({ mode, projectRoot: root, allowedPaths: [], rules: rules(r) }, tool, input);

describe("rule matching", () => {
  it("matches tool names, with * globs", () => {
    expect(evaluateRules(rules({ allow: ["read_file"] }), "read_file", { path: "a.ts" }, root)?.verdict).toBe("allow");
    expect(evaluateRules(rules({ allow: ["mcp_github_*"] }), "mcp_github_create_issue", {}, root)?.verdict).toBe("allow");
    expect(evaluateRules(rules({ allow: ["mcp_github_*"] }), "mcp_slack_post", {}, root)).toBeNull();
  });

  it("matches shell commands, a trailing * or :* also covering the bare command", () => {
    const r = rules({ allow: ["shell(npm test)", "shell(git log *)", "shell(pnpm run test:*)"] });
    expect(evaluateRules(r, "shell", { command: "npm test" }, root)?.verdict).toBe("allow");
    expect(evaluateRules(r, "shell", { command: "npm test -- --watch" }, root)).toBeNull();
    expect(evaluateRules(r, "shell", { command: "git log" }, root)?.verdict).toBe("allow");
    expect(evaluateRules(r, "shell", { command: "git log --oneline -3" }, root)?.verdict).toBe("allow");
    expect(evaluateRules(r, "shell", { command: "pnpm run test" }, root)?.verdict).toBe("allow");
    expect(evaluateRules(r, "shell", { command: "git push" }, root)).toBeNull();
  });

  it("allows a shell line only when every command on it is allowed", () => {
    const r = rules({ allow: ["shell(npm test)", "shell(git status)"] });
    expect(evaluateRules(r, "shell", { command: "git status && npm test" }, root)?.verdict).toBe("allow");
    expect(evaluateRules(r, "shell", { command: "npm test && rm -rf src" }, root)).toBeNull();
    expect(evaluateRules(r, "shell", { command: "npm test > out.txt" }, root)).toBeNull();
  });

  it("denies a shell line when any command on it is denied", () => {
    const r = rules({ deny: ["shell(git push *)"], allow: ["shell(*)"] });
    expect(evaluateRules(r, "shell", { command: "git add . && git push origin main" }, root)?.verdict).toBe("deny");
    expect(evaluateRules(r, "shell", { command: "git push $(git remote)" }, root)?.verdict).toBe("deny");
  });

  it("matches file tools on paths relative to the project, ** crossing directories", () => {
    const r = rules({ allow: ["edit_file(src/**)"], deny: ["read_file(secrets/*)"] });
    expect(evaluateRules(r, "edit_file", { path: "src/a/b.ts" }, root)?.verdict).toBe("allow");
    expect(evaluateRules(r, "edit_file", { path: `${root}/src/c.ts` }, root)?.verdict).toBe("allow");
    expect(evaluateRules(r, "edit_file", { path: "test/a.ts" }, root)).toBeNull();
    expect(evaluateRules(r, "read_file", { path: "secrets/key.txt" }, root)?.verdict).toBe("deny");
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: test/a.ts\n@@\n-a\n+b\n*** End Patch";
    expect(evaluateRules(rules({ allow: ["apply_patch(src/**)"] }), "apply_patch", { patch }, root, ["src/a.ts", "test/a.ts"])).toBeNull();
    expect(evaluateRules(rules({ allow: ["apply_patch(src/**)"] }), "apply_patch", { patch }, root, ["src/a.ts"])?.verdict).toBe("allow");
  });
});

describe("rules in the permission check", () => {
  it("an allow rule runs a command suggest mode would ask about, even a warn pattern", () => {
    expect(check("suggest", {}, "shell", { command: "npm test" }).verdict).toBe("ask");
    expect(check("suggest", { allow: ["shell(npm test)"] }, "shell", { command: "npm test" }).verdict).toBe("allow");
    expect(check("suggest", { allow: ["shell(git push --force *)"] }, "shell", { command: "git push --force origin x" }).verdict).toBe("allow");
  });

  it("a deny rule wins in every mode, over allow rules and read-only tools", () => {
    expect(check("full-auto", { deny: ["shell(git push *)"] }, "shell", { command: "git push" }).verdict).toBe("deny");
    expect(check("full-auto", { deny: ["web_fetch"], allow: ["web_fetch"] }, "web_fetch", { url: "https://x" }).verdict).toBe("deny");
    expect(check("suggest", { deny: ["grep"] }, "grep", { pattern: "x" }).verdict).toBe("deny");
  });

  it("an ask rule asks even for a read-only tool or in full-auto", () => {
    expect(check("suggest", { ask: ["read_file(docs/*)"] }, "read_file", { path: "docs/a.md" }).verdict).toBe("ask");
    expect(check("full-auto", { ask: ["shell(npm publish *)"] }, "shell", { command: "npm publish" }).verdict).toBe("ask");
  });

  it("no rule overrides the hard limits: blocked commands, secret files, paths outside the project", () => {
    expect(check("suggest", { allow: ["shell(*)"] }, "shell", { command: "rm -rf /" }).verdict).toBe("deny");
    expect(check("suggest", { allow: ["read_file"] }, "read_file", { path: `${root}/.env` }).verdict).toBe("deny");
    expect(check("suggest", { allow: ["write_file"] }, "write_file", { path: "/etc/elsewhere.txt" }).verdict).toBe("ask");
  });
});

describe("where rules come from", () => {
  it("merges the user file, the project file and the command line", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rules-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "rules-proj-"));
    try {
      fs.mkdirSync(path.join(home, ".phren-agent"));
      fs.writeFileSync(path.join(home, ".phren-agent", "settings.json"), JSON.stringify({ theme: "x", permissions: { allow: ["read_file"], deny: ["shell(git push *)"] } }));
      fs.mkdirSync(path.join(project, ".phren-agent"));
      fs.writeFileSync(path.join(project, ".phren-agent", "settings.json"), JSON.stringify({ permissions: { ask: ["web_fetch"], allow: [3, "shell(npm test)"] } }));
      const loaded = loadPermissionRules(project, { allow: ["glob"], deny: ["write_file"] }, home);
      expect(loaded).toEqual({
        allow: ["read_file", "shell(npm test)", "glob"],
        ask: ["web_fetch"],
        deny: ["shell(git push *)", "write_file"],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("reads --allowedTools and --disallowedTools, commas inside parentheses kept", () => {
    expect(parseRuleList("read_file, shell(git log *), edit_file(src/{a,b}.ts)")).toEqual(["read_file", "shell(git log *)", "edit_file(src/{a,b}.ts)"]);
    const args = parseArgs(["--allowedTools", "read_file,shell(npm test)", "--disallowed-tools", "web_fetch", "-p", "do it"]);
    expect(args.allowedTools).toEqual(["read_file", "shell(npm test)"]);
    expect(args.disallowedTools).toEqual(["web_fetch"]);
  });
});
