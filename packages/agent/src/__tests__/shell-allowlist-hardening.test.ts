// Auto-confirm bypasses a Codex review of #660 found (2026-10-27). Each command line was auto-approved
// in a project cwd; each must now ask, and the everyday reads and builds must still run unprompted.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPermission } from "../permissions/checker.js";
import { isAutoApprovableCommand } from "../permissions/shell-classify.js";
import type { PermissionConfig } from "../permissions/types.js";

let root = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
const verdict = (command: string, cwd = root) => {
  const config: PermissionConfig = { mode: "auto-confirm", projectRoot: root, allowedPaths: [] };
  return checkPermission(config, "shell", { command, cwd }).verdict;
};

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-allowlist-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "README.md"), "pattern\n");
  fs.writeFileSync(path.join(root, "file.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const pattern = 1;\n");
  fs.writeFileSync(path.join(root, "config", "secrets.json"), "{}\n");
  fs.writeFileSync(path.join(root, "secrets.json"), "{}\n");
  // A package whose secrets rg and git grep never read: an ignored node_modules and a hidden example file.
  fs.mkdirSync(path.join(root, "pkg", "node_modules", "dep"), { recursive: true });
  fs.mkdirSync(path.join(root, "pkg", "src"));
  fs.writeFileSync(path.join(root, "pkg", ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(root, "pkg", "node_modules", "dep", "secrets.json"), "x\n");
  fs.writeFileSync(path.join(root, "pkg", ".env.example"), "x\n");
  fs.writeFileSync(path.join(root, "pkg", "src", "b.ts"), "x\n");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  // The owner's own global config (a difftool, say) must not decide these tests.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  git("init", "-q");
  git("add", "-A");
});

describe("everyday commands stay unprompted", () => {
  it.each(["git status", "git log -5", "git diff", "rg pattern src", "grep -n pattern README.md", "ls -la", "cat README.md",
    "sort README.md", "head -20 README.md", "jq . file.json", "npm test", "pnpm lint", "cd src && ls", "echo hi >&2",
    "ls 2>&1 | head -5", "ls >/dev/null", "printf '%s\\n' hi", "grep -rn pattern src"])("%s", (command) => {
    expect(verdict(command)).toBe("allow");
  });
});

describe("the auto-approve bypasses ask", () => {
  // 1. An inherited Object member is not a git subcommand (a git alias of that name would run).
  it.each(["git constructor", "git toString", "git __proto__", "git hasOwnProperty", "constructor", "npm constructor"])("%s", (command) => {
    expect(isAutoApprovableCommand(command)).toBe(false);
    expect(verdict(command)).toBe("ask");
  });

  // 2. With -f the filter comes from the file, so the first operand is an input file.
  it("jq -f reads its first operand", () => {
    expect(verdict("printf . | jq -Rf /dev/stdin secrets.json")).toBe("ask");
    expect(verdict("jq -f /dev/stdin secrets.json")).toBe("ask");
  });

  // 3. Arguments after `--` reach the script's own tool.
  it.each(["npm run lint -- --fix", "pnpm run lint -- --fix", "yarn run lint -- --write", "npx eslint -- --fix src"])("%s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  // 4. A redirection's whole target must be a descriptor or /dev/null.
  it.each(["echo owned >&1pwned", "echo owned >&2x", "echo owned >/dev/nullx", "echo owned &>/dev/null.d"])("%s", (command) => {
    expect(isAutoApprovableCommand(command)).toBe(false);
    expect(verdict(command)).toBe("ask");
  });

  // 5. bash joins a word across a backslash-newline.
  it.each(["cat sec\\\nrets.json", "cat \"sec\\\nrets.json\""])("a line continuation: %j", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  // 6. Later segments resolve where `cd` left the shell.
  it.each(["cd ~/.aws && cat credentials", "cd config && cat secrets.json", "cd config; head -1 secrets.json", "cd .. && ls",
    "cd / && cat etc/hosts", "cd && ls", "cd - && ls"])("%s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  // 7. A recursive read reaches the files below its operand.
  it.each(["grep -r . .", "grep -R x config", "grep -d recurse x .", "rg x", "rg x .", "diff -r src config",
    "git grep x"])("%s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it("asks for a recursive read that follows a symlink below it", () => {
    fs.symlinkSync(path.join(root, "README.md"), path.join(root, "src", "link"));
    try {
      expect(verdict("rg -L x src")).toBe("ask");
      expect(verdict("grep -R x src")).toBe("ask");
      expect(verdict("rg x src")).toBe("allow");
    } finally { fs.rmSync(path.join(root, "src", "link")); }
  });

  // 8. Names read from a list no check here sees.
  it.each(["printf 'secrets.json\\0' | sort --files0-from=-", "wc --files0-from=list", "sha256sum -c sums.txt", "md5sum --check sums.txt",
    "file -f names.txt"])("%s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  // 9. Repository config that runs a program on a read. (`true` stands in for the program.)
  it.each([["diff.external", "true"], ["diff.x.textconv", "true"], ["diff.x.command", "true"], ["filter.x.clean", "true"]])(
    "git diff with %s set", (key, value) => {
      expect(verdict("git diff -- README.md")).toBe("allow");
      git("config", key, value);
      expect(verdict("git diff -- README.md")).toBe("ask");
      expect(verdict("git status")).toBe("ask");
      expect(verdict("cd src && git log -1")).toBe("ask");
    });

  // 10. printf -v assigns a variable, PATH among them.
  it.each(["printf -v PATH .; ls", "printf -vPATH . && ls", "printf -v x %s y"])("%s", (command) => {
    expect(isAutoApprovableCommand(command)).toBe(false);
    expect(verdict(command)).toBe("ask");
  });
});

// Found by the adversarial review of the fixes above.
describe("the fixes' own gaps ask", () => {
  // A backslash-quote inside double quotes does not end the quote.
  it("reads `\\\"` inside double quotes as a quote character", () => {
    expect(isAutoApprovableCommand('echo "a\\" "; touch pwned #"')).toBe(false);
    expect(verdict('echo "a\\" "; touch pwned #"')).toBe("ask");
    expect(verdict('echo "a\\"b" "c\\\\"')).toBe("allow");
  });

  it("lets a cd that fails stop the rest", () => {
    expect(verdict("cd nosuch && ls")).toBe("allow");
    expect(verdict("cd nosuch && ls | head -1")).toBe("allow");
  });

  it.each(["cd nosuch; rg x", "cd nosuch; git diff", "cd nosuch && ls; rg x", "cd README.md; cat secrets.json", "cd src | rg x", "rg x | cd src",
    "cd src || cat ../secrets.json", "cd src && ls || cat secrets.json"])("a cd that may not move the next command: %s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it.each(["rg . ~root/.aws", "cd ~+ && ls", "cat ~-/x", "grep -r . ~nobody", "cat a=~root/x"])("an unexpanded tilde: %s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it("walks a recursive read that starts at a symlink where it leads", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-outside-")));
    fs.mkdirSync(path.join(outside, ".aws"));
    fs.writeFileSync(path.join(outside, ".aws", "credentials"), "x\n");
    fs.symlinkSync(path.join(outside, ".aws"), path.join(root, "awslink"));
    try {
      for (const command of ["rg x awslink", "grep -r x awslink", "rg x awslink/"]) expect(verdict(command)).toBe("ask");
    } finally { fs.unlinkSync(path.join(root, "awslink")); fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it.each(["git diff --no-index src config", "git grep -e x -- ..", "git grep x :/", "git grep x -- ':(top)'",
    "git log --format=%G? -1", "git log --pretty=format:%GS -1"])("%s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it.each(["jq -n 'import \"secrets\" as $s {search: \"./config\"}; $s::s'", "jq -n 'include \"x\"; .'", "jq -f f.jq file.json"])("jq: %s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it.each(["grep -d rec x .", "grep -d RECURSE x .", "grep --directories=recu x ."])("%s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it.each(["npm run lint:fix", "pnpm run lint:fix", "bun run lint:fix", "npm run test:update", "yarn run lint:write"])("%s", (command) => {
    expect(verdict(command)).toBe("ask");
  });

  it.each(["grep -d skip x README.md", "npm run lint:ci", "cd src && git grep x", "git log --format=%h -1"])("still allows %s", (command) => {
    expect(verdict(command)).toBe("allow");
  });
});

describe("recursive reads and git config the owner's tools set up", () => {
  it("lets rg skip what git ignores and hidden files, as rg does", () => {
    expect(verdict("rg x pkg")).toBe("allow");
    expect(verdict("cd pkg && rg x")).toBe("allow");
    for (const command of ["rg --hidden x pkg", "rg -. x pkg", "rg -u x pkg", "rg --no-ignore x pkg", "rg -g '*' x pkg", "grep -r x pkg"]) {
      expect(verdict(command)).toBe("ask");
    }
  });

  it("allows git-lfs's own filter and asks for one that runs anything else", () => {
    git("config", "filter.lfs.clean", "git-lfs clean -- %f");
    git("config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    git("config", "filter.lfs.process", "git-lfs filter-process");
    expect(verdict("git status")).toBe("allow");
    git("config", "filter.lfs.clean", "git-lfs clean -- %f; true");
    expect(verdict("git status")).toBe("ask");
  });

  it("allows git-crypt's filter and textconv", () => {
    git("config", "filter.git-crypt.smudge", '"git-crypt" smudge');
    git("config", "filter.git-crypt.clean", '"git-crypt" clean');
    git("config", "diff.git-crypt.textconv", '"git-crypt" diff');
    expect(verdict("git diff")).toBe("allow");
    git("config", "diff.git-crypt.textconv", `"${root}/git-crypt" diff`);
    expect(verdict("git diff")).toBe("ask");
  });
});

describe("every agent shell runs git with its helpers off", () => {
  it("passes fsmonitor, pager and signature overrides after the caller's own", async () => {
    const { shellEnv } = await import("../permissions/shell-safety.js");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "user.name");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "kept");
    git("config", "core.pager", "less");
    const env = shellEnv();
    const get = (key: string) => execFileSync("git", ["config", "--get", key], { cwd: root, env, encoding: "utf-8" }).trim();
    expect([get("core.fsmonitor"), get("core.pager"), get("log.showSignature"), get("user.name")]).toEqual(["false", "cat", "false", "kept"]);
  });
});
