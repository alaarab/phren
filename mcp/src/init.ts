import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version as string;
const STARTER_DIR = path.join(ROOT, "starter");

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function patchJsonFile(filePath: string, patch: (data: Record<string, any>) => void) {
  let data: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      // malformed json, start fresh
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  patch(data);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function resolveEntryScript(): string {
  // Find the actual index.js path so hooks can use `node <path>` instead of npx
  return path.join(ROOT, "mcp", "dist", "index.js");
}

function configureClaude(cortexPath: string) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const entryScript = resolveEntryScript();

  patchJsonFile(settingsPath, (data) => {
    // MCP server
    if (!data.mcpServers) data.mcpServers = {};
    if (!data.mcpServers.cortex) {
      data.mcpServers.cortex = {
        command: "npx",
        args: ["-y", `@alaarab/cortex@${VERSION}`, cortexPath],
      };
    }

    // Hooks: always update to latest version
    if (!data.hooks) data.hooks = {};

    // UserPromptSubmit hook: auto-inject cortex context into every prompt
    const promptHook = {
      type: "command",
      command: `node ${entryScript} hook-prompt`,
      timeout: 3,
    };
    const existingPrompt = data.hooks.UserPromptSubmit as any[] | undefined;
    const hasCortexPromptHook = existingPrompt?.some(
      (h: any) => h.hooks?.some((hook: any) => hook.command?.includes("cortex") && hook.command?.includes("hook-prompt"))
    );
    if (!hasCortexPromptHook) {
      if (!data.hooks.UserPromptSubmit) data.hooks.UserPromptSubmit = [];
      data.hooks.UserPromptSubmit.push({ matcher: "", hooks: [promptHook] });
    }

    // Stop hook: auto-commit cortex changes
    const stopHook = {
      type: "command",
      command: "cd ~/.cortex && git diff --quiet 2>/dev/null || (git add -A && git commit -m 'auto-save cortex' && git push 2>/dev/null || true)",
    };
    const existingStop = data.hooks.Stop as any[] | undefined;
    const hasCortexStopHook = existingStop?.some(
      (h: any) => h.hooks?.some((hook: any) => hook.command?.includes(".cortex") && hook.command?.includes("auto-save"))
    );
    if (!hasCortexStopHook) {
      if (!data.hooks.Stop) data.hooks.Stop = [];
      data.hooks.Stop.push({ matcher: "", hooks: [stopHook] });
    }

    // SessionStart hook: auto-pull cortex on session start
    const startHook = {
      type: "command",
      command: "cd ~/.cortex && git pull --rebase --quiet 2>/dev/null || true",
    };
    const existingStart = data.hooks.SessionStart as any[] | undefined;
    const hasCortexStartHook = existingStart?.some(
      (h: any) => h.hooks?.some((hook: any) => hook.command?.includes(".cortex") && hook.command?.includes("git pull"))
    );
    if (!hasCortexStartHook) {
      if (!data.hooks.SessionStart) data.hooks.SessionStart = [];
      data.hooks.SessionStart.push({ matcher: "", hooks: [startHook] });
    }
  });
  return !JSON.parse(fs.readFileSync(settingsPath, "utf8")).mcpServers?.cortex
    ? "skipped"
    : "installed";
}

function configureVSCode(cortexPath: string) {
  const candidates = [
    path.join(os.homedir(), ".config", "Code", "User"),
    path.join(os.homedir(), "Library", "Application Support", "Code", "User"),
    path.join(os.homedir(), "AppData", "Roaming", "Code", "User"),
  ];
  const vscodeDir = candidates.find((d) => fs.existsSync(d));
  if (!vscodeDir) return "no_vscode";

  const mcp_file = path.join(vscodeDir, "mcp.json");
  if (fs.existsSync(mcp_file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(mcp_file, "utf8"));
      if (existing?.servers?.cortex) return "already_configured";
    } catch {}
  }

  patchJsonFile(mcp_file, (data) => {
    if (!data.servers) data.servers = {};
    data.servers.cortex = {
      command: "npx",
      args: ["-y", `@alaarab/cortex@${VERSION}`, cortexPath],
    };
  });
  return "installed";
}

function updateMachinesYaml(cortexPath: string) {
  const machinesFile = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return;
  const hostname = os.hostname();
  let content = fs.readFileSync(machinesFile, "utf8");
  // Replace placeholder comment block with actual hostname entry
  if (!content.includes(hostname)) {
    content = content.replace(
      /^#.*\n/gm,
      ""
    ).trim();
    content = `${hostname}: personal\n\n` + content;
    fs.writeFileSync(machinesFile, content);
  }
}

export async function runInit() {
  const home = os.homedir();
  const cortexPath = path.join(home, ".cortex");

  if (fs.existsSync(cortexPath)) {
    const entries = fs.readdirSync(cortexPath);
    if (entries.length > 0) {
      log(`\ncortex already exists at ${cortexPath}`);
      log(`Updating MCP + hook configuration...\n`);

      // Always reconfigure MCP and hooks (picks up new features on upgrade)
      try {
        configureClaude(cortexPath);
        log(`  Updated Claude Code MCP + hooks`);
      } catch (e) {
        log(`  Could not configure Claude Code MCP (${e}), add manually`);
      }

      try {
        const vscodeResult = configureVSCode(cortexPath);
        if (vscodeResult === "installed") log(`  Updated VS Code MCP`);
      } catch {}

      log(`\nDone. Restart Claude Code to pick up changes.\n`);
      process.exit(0);
    }
  }

  log("\nSetting up cortex...\n");

  // Copy bundled starter to ~/.cortex
  function copyDir(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  if (fs.existsSync(STARTER_DIR)) {
    copyDir(STARTER_DIR, cortexPath);
    log(`  Created cortex v${VERSION} → ${cortexPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "my-first-project"), { recursive: true });
    fs.writeFileSync(
      path.join(cortexPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "summary.md"),
      `# my-first-project\n\n**What:** Replace this with one sentence about what the project does\n**Stack:** The key tech\n**Status:** active\n**Run:** the command you use most\n**Gotcha:** the one thing that will bite you if you forget\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "CLAUDE.md"),
      `# my-first-project\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "LEARNINGS.md"),
      `# my-first-project LEARNINGS\n\n<!-- Learnings are captured automatically during sessions and committed on exit -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "backlog.md"),
      `# my-first-project backlog\n\n## Active\n\n## Queue\n\n## Done\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "profiles", "personal.yaml"),
      `name: personal\ndescription: Default profile\nprojects:\n  - global\n  - my-first-project\n`
    );
  }

  // Update machines.yaml with real hostname
  updateMachinesYaml(cortexPath);
  log(`  Updated machines.yaml with hostname "${os.hostname()}"`);

  // Configure Claude Code
  try {
    configureClaude(cortexPath);
    log(`  Configured Claude Code MCP + hooks`);
  } catch (e) {
    log(`  Could not configure Claude Code MCP (${e}), add manually`);
  }

  // Configure VS Code
  try {
    const vscodeResult = configureVSCode(cortexPath);
    if (vscodeResult === "installed") log(`  Configured VS Code MCP`);
    else if (vscodeResult === "already_configured") log(`  VS Code MCP already configured`);
    // no_vscode: skip silently
  } catch {
    // skip
  }

  log(`\nDone. Your knowledge base is at ${cortexPath}\n`);
  log(`Next steps:`);
  log(`  1. Create a private GitHub repo and push your cortex:`);
  log(`     cd ${cortexPath}`);
  log(`     git init`);
  log(`     git add .`);
  log(`     git commit -m "Initial cortex setup"`);
  log(`     git remote add origin git@github.com:YOUR_USERNAME/cortex.git`);
  log(`     git push -u origin main`);
  log(`  2. Restart Claude Code to activate the MCP server`);
  log(`  3. Open a project and run /cortex-init <name> to add it\n`);
}
