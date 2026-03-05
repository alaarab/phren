import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const STARTER_REPO = "https://github.com/alaarab/cortex-starter.git";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
const VERSION = pkg.version as string;

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

function configureClaude(cortexPath: string) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  patchJsonFile(settingsPath, (data) => {
    if (!data.mcpServers) data.mcpServers = {};
    if (data.mcpServers.cortex) return; // already configured
    data.mcpServers.cortex = {
      command: "npx",
      args: ["-y", `@alaarab/cortex@${VERSION}`, cortexPath],
    };
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
      log(`To add a project: run /cortex-init <name> in Claude Code`);
      log(`To reconfigure MCP, delete ${cortexPath} and run init again.\n`);
      process.exit(0);
    }
  }

  log("\nSetting up cortex...\n");

  // Clone cortex-starter
  let cloned = false;
  try {
    execSync(`git clone --depth 1 ${STARTER_REPO} "${cortexPath}" 2>&1`, {
      stdio: "pipe",
    });
    // Remove .git so user starts fresh
    fs.rmSync(path.join(cortexPath, ".git"), { recursive: true, force: true });
    log(`  Cloned cortex-starter → ${cortexPath}`);
    cloned = true;
  } catch {
    // Fallback: scaffold minimal structure inline
    log(`  Could not clone cortex-starter, scaffolding minimal structure...`);
    fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "my-first-project"), { recursive: true });
    fs.writeFileSync(
      path.join(cortexPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "summary.md"),
      `# my-first-project\n\nWhat: Replace this with one sentence about what the project does\nStack: The key tech\nStatus: active\nRun: the command you use most\nGotcha: the one thing that will bite you if you forget\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "CLAUDE.md"),
      `# my-first-project\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "LEARNINGS.md"),
      `# my-first-project LEARNINGS\n\n<!-- Add session learnings here, or run /cortex-learn in Claude Code -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "backlog.md"),
      `# my-first-project backlog\n\n## Active\n\n## Queue\n\n## Done\n`
    );
    const hostname = os.hostname();
    fs.writeFileSync(
      path.join(cortexPath, "machines.yaml"),
      `# Maps machine hostnames to profiles.\n# Run \`hostname\` to find your machine name.\n${hostname}: personal\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "profiles", "personal.yaml"),
      `name: personal\ndescription: Default profile\nprojects:\n  - global\n  - my-first-project\n`
    );
  }

  // Update machines.yaml with real hostname
  if (cloned) {
    updateMachinesYaml(cortexPath);
    log(`  Updated machines.yaml with hostname "${os.hostname()}"`);
  }

  // Configure Claude Code
  try {
    configureClaude(cortexPath);
    log(`  Configured Claude Code MCP`);
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
