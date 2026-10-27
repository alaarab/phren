// A second Codex pass over #664 (2026-10-27): seven command lines auto-confirm ran that must ask, and four it
// asked about that must run. Auto-confirm, cwd in the project, no permission rules.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPermission } from "../permissions/checker.js";
import { isAutoApprovableCommand } from "../permissions/shell-classify.js";
import type { PermissionConfig } from "../permissions/types.js";

let root = "", outside = "";
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
const verdict = (command: string) => {
  const config: PermissionConfig = { mode: "auto-confirm", projectRoot: root, allowedPaths: [] };
  return checkPermission(config, "shell", { command, cwd: root }).verdict;
};
const write = (file: string, text = "x\n") => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-pass2-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-pass2-out-")));
  fs.writeFileSync(path.join(outside, "public.txt"), "x\n");
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  write("README.md", "TOKEN\n");
  write("public.txt");
  write("file.json", "{}\n");
  write("src/a.ts", "TOKEN\n");
  write("config/secrets.json", "{}\n");
  // Two commits: the first adds the secret, the second changes only README.md.
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "one");
  write("README.md", "TOKEN 2\n");
  git("commit", "-qam", "two");
});

describe("the second pass's gaps ask", () => {
  it("checks every path a read names against the project", () => {
    fs.symlinkSync(path.join(outside, "public.txt"), path.join(root, "outlink"));
    expect(verdict(`cat ${outside}/public.txt`)).toBe("ask");
    expect(verdict("cat outlink")).toBe("ask");
    expect(verdict("head -1 ../x")).toBe("ask");
    for (const command of ["cat /dev/null", "jq . /dev/stdin", "cat README.md", "grep -n TOKEN README.md", "sort - README.md"]) {
      expect(verdict(command)).toBe("allow");
    }
  });

  it("checks what a recursive read follows a link to against the project", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "phren-fake-grep-"));
    fs.symlinkSync(outside, path.join(root, "src", "outdir"));
    // A grep that lists the link's file, as GNU grep -R does.
    fs.writeFileSync(path.join(bin, "grep"), "#!/bin/sh\nprintf 'src/outdir/public.txt\\0'\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    try {
      expect(verdict("grep -R TOKEN src")).toBe("ask");
      expect(verdict("grep -r TOKEN src")).toBe("allow");
    } finally { fs.rmSync(bin, { recursive: true, force: true }); }
  });

  it("checks the files a git diff, log -p or show prints a patch of", () => {
    expect(verdict("git diff")).toBe("allow");
    expect(verdict("git log -p -1")).toBe("allow");
    expect(verdict("git show HEAD")).toBe("allow");
    expect(verdict("git show")).toBe("allow");
    expect(verdict("git show HEAD:README.md")).toBe("allow");
    // The first commit added the secret.
    expect(verdict("git log -p -2")).toBe("ask");
    expect(verdict("git log --patch")).toBe("ask");
    expect(verdict("git show HEAD~1")).toBe("ask");
    write("config/secrets.json", '{"k":1}\n');
    expect(verdict("git diff")).toBe("ask");
    expect(verdict("git diff --stat")).toBe("ask");
    expect(verdict("git diff -- src")).toBe("allow");
    git("add", "config/secrets.json");
    expect(verdict("git diff")).toBe("allow");
    expect(verdict("git diff --cached")).toBe("ask");
    expect(verdict("git diff --staged -- README.md")).toBe("allow");
    expect(verdict("git diff HEAD")).toBe("ask");
  });

  it("asks for git log -L, whose file is inside its value", () => {
    expect(isAutoApprovableCommand("git log -L 1,5:config/secrets.json")).toBe(false);
    expect(verdict("git log -L 1,5:config/secrets.json")).toBe("ask");
  });

  it.each(['echo "$[PATH=0]"; cat README.md', "echo $[PATH=0]; cat README.md", "echo \"a$[1]\""])("old arithmetic: %s", (command) => {
    expect(isAutoApprovableCommand(command)).toBe(false);
    expect(verdict(command)).toBe("ask");
  });

  it("asks for a printf format that assigns or can't be read", () => {
    for (const command of ["printf '%n' PATH; cat README.md", "printf 'a%5n' PATH", "printf 'x\\101'", "printf '\\045n' PATH", "printf '%z'"]) {
      expect(isAutoApprovableCommand(command)).toBe(false);
      expect(verdict(command)).toBe("ask");
    }
    for (const command of ["printf '%s %d\\n' a 1", "printf '%%n'", "printf -- '%-10s|%5.2f\\n' a 1", "printf hi"]) {
      expect(verdict(command)).toBe("allow");
    }
  });

  it("follows cd -P to where the link leads, and cd .. from there", () => {
    fs.mkdirSync(path.join(root, "actual", "deep"), { recursive: true });
    fs.symlinkSync(path.join(root, "actual", "deep"), path.join(root, "link"));
    fs.symlinkSync(path.join(root, "config", "secrets.json"), path.join(root, "actual", "public.txt"));
    expect(verdict("cd -P link; cd ..; cat public.txt")).toBe("ask");
    expect(verdict("cd -L -P link && cd .. && cat public.txt")).toBe("ask");
    // Logically, `cd ..` from link is the project again, whose public.txt is harmless.
    expect(verdict("cd link; cd ..; cat public.txt")).toBe("allow");
    expect(verdict("cd -P -L link; cd ..; cat public.txt")).toBe("allow");
  });

  it("expands only a tilde bash expands", () => {
    fs.mkdirSync(path.join(root, "~"));
    fs.symlinkSync(path.join(root, "config", "secrets.json"), path.join(root, "~", "public.txt"));
    // A file under a directory named `~` in the project, not the home directory.
    expect(verdict("cat '~/public.txt'")).toBe("ask");
    expect(verdict('cat "~"/public.txt')).toBe("ask");
    expect(verdict("cat \\~/public.txt")).toBe("ask");
    // The home directory is outside the project.
    expect(verdict("cat ~/public.txt")).toBe("ask");
    fs.rmSync(path.join(root, "~", "public.txt"));
    fs.writeFileSync(path.join(root, "~", "public.txt"), "x\n");
    expect(verdict("cat '~/public.txt'")).toBe("allow");
  });
});

// Found by the adversarial review of these fixes.
describe("the review's gaps in the git reads ask", () => {
  it("lists the patch git status -v prints", () => {
    expect(verdict("git status -v")).toBe("allow");
    write("config/secrets.json", '{"k":1}\n');
    git("add", "config/secrets.json");
    expect(verdict("git status -v")).toBe("ask");
    expect(verdict("git status -vv")).toBe("ask");
    expect(verdict("git status")).toBe("allow");
  });

  it("takes --binary as the patch it implies", () => {
    expect(verdict("git log --binary -2")).toBe("ask");
    expect(verdict("git log --binary -1")).toBe("allow");
  });

  it("checks textconv for a pickaxe log", () => {
    git("config", "diff.x.textconv", "true");
    expect(verdict("git log -S TOKEN -1")).toBe("ask");
    expect(verdict("git log -G TOKEN -1")).toBe("ask");
    expect(verdict("git log -1")).toBe("allow");
  });

  it("asks for a known git read whose options it can't read, even once the session approved it", async () => {
    const { addAllow, clearAllowlist } = await import("../permissions/allowlist.js");
    const config: PermissionConfig = { mode: "auto-confirm", projectRoot: root, allowedPaths: [] };
    addAllow("shell", { command: "git log -1" }, "session");
    try {
      expect(checkPermission(config, "shell", { command: "git log -1", cwd: root }).verdict).toBe("allow");
      expect(checkPermission(config, "shell", { command: "git log -p --ext-diff -1", cwd: root }).verdict).toBe("ask");
      expect(checkPermission(config, "shell", { command: "git log -L1,9:config/secrets.json", cwd: root }).verdict).toBe("ask");
    } finally { clearAllowlist(); }
  });

  it("reads REV:PATH from the repository's top, and a reflog date's colon as part of the revision", () => {
    // The project is a folder of a bigger repository; its sibling holds the secret.
    write("pkg/README.md", "x\n");
    write("other/secrets.yaml", "x\n");
    git("add", "-A");
    git("commit", "-qm", "three");
    const config: PermissionConfig = { mode: "auto-confirm", projectRoot: path.join(root, "pkg"), allowedPaths: [] };
    const inPkg = (command: string) => checkPermission(config, "shell", { command, cwd: path.join(root, "pkg") }).verdict;
    expect(inPkg("git show HEAD:pkg/README.md")).toBe("allow");
    expect(inPkg("git show HEAD:other/secrets.yaml")).toBe("ask");
    expect(inPkg("git show HEAD:README.md")).toBe("ask");
    expect(inPkg("git show HEAD:./README.md")).toBe("allow");
    // A blob outside the project, though not a secret.
    expect(inPkg("git show HEAD:src/a.ts")).toBe("ask");
    expect(verdict("git show 'HEAD@{2020-01-01 10:00}'")).toBe("ask");
  });

  it("asks for copy detection that takes unchanged files as sources", () => {
    expect(verdict("git diff -C -C")).toBe("ask");
    expect(verdict("git log -p -C -C -1")).toBe("ask");
    expect(verdict("git diff -C")).toBe("allow");
  });
});

describe("the everyday commands still run", () => {
  it.each(["git status", "git log -5", "git diff", "grep -n TOKEN README.md", "ls -la", "cat README.md", "sort README.md",
    "head -20 README.md", "jq . file.json", "npm test", "pnpm lint", "cd src && ls"])("%s", (command) => {
    expect(verdict(command)).toBe("allow");
  });
});

describe("the second pass's regressions run", () => {
  it("lists only the files a git grep's pathspec matches", () => {
    expect(verdict("git grep TOKEN -- src")).toBe("allow");
    expect(verdict("git grep TOKEN src README.md")).toBe("allow");
    expect(verdict("git grep TOKEN")).toBe("ask");
    expect(verdict("git grep TOKEN -- config")).toBe("ask");
  });

  it("lets grep's own --exclude, --exclude-dir and --include choose what it reads", () => {
    expect(verdict("grep -r --exclude=secrets.json TOKEN config")).toBe("allow");
    expect(verdict("grep -r TOKEN config")).toBe("ask");
    expect(verdict("grep -rn --exclude-dir=config --exclude-dir=.git TOKEN .")).toBe("allow");
    expect(verdict("grep -r --include='*.ts' TOKEN .")).toBe("allow");
    expect(verdict("grep -r --include='*.json' TOKEN .")).toBe("ask");
  });

  it.each(["jq '.import' file.json", "jq '\"include\"' file.json", "jq '.a | {import: 1}' file.json", "jq '.module' file.json"])("jq: %s", (command) => {
    expect(verdict(command)).toBe("allow");
  });

  it.each(["jq 'import \"x\" as $x; .' file.json", "jq '  include \"x\"; .' file.json", "jq '# c\nimport \"x\" as $x; .' file.json",
    "jq 'module {a: 1}; .' file.json"])("jq directive: %j", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it("runs git log -5 when a clean filter or textconv is configured but unused", () => {
    git("config", "filter.x.clean", "true");
    git("config", "diff.x.textconv", "true");
    expect(verdict("git log -5")).toBe("allow");
    expect(verdict("git log --oneline -3")).toBe("allow");
    expect(verdict("git log --stat -1")).toBe("ask");
    expect(verdict("git status")).toBe("ask");
  });
});
