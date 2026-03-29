/**
 * Team store CLI commands: init, join, add-project.
 * Creates and manages shared phren stores for team collaboration.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getPhrenPath } from "../shared.js";
import { isValidProjectName } from "../utils.js";
import {
  addStoreToRegistry,
  findStoreByName,
  generateStoreId,
  readTeamBootstrap,
  updateStoreProjects,
  type StoreEntry,
  type TeamBootstrap,
} from "../store-registry.js";

const EXEC_TIMEOUT_MS = 30_000;

function getOptionValue(args: string[], name: string): string | undefined {
  const exactIdx = args.indexOf(name);
  if (exactIdx !== -1) return args[exactIdx + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

function getPositionalArgs(args: string[], optionNames: string[]): string[] {
  const positions: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (optionNames.includes(arg)) { i++; continue; }
    if (optionNames.some((name) => arg.startsWith(`${name}=`))) continue;
    if (!arg.startsWith("--")) positions.push(arg);
  }
  return positions;
}

function atomicWriteText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ── phren team init <name> [--remote <url>] [--description <desc>] ──────────

async function handleTeamInit(args: string[]): Promise<void> {
  const phrenPath = getPhrenPath();
  const positional = getPositionalArgs(args, ["--remote", "--description"]);
  const name = positional[0];
  const remote = getOptionValue(args, "--remote");
  const description = getOptionValue(args, "--description");

  if (!name) {
    console.error("Usage: phren team init <name> [--remote <url>] [--description <text>]");
    process.exit(1);
  }
  if (!isValidProjectName(name)) {
    console.error(`Invalid store name: "${name}". Use lowercase letters, numbers, hyphens.`);
    process.exit(1);
  }

  // Check if store already exists
  const existing = findStoreByName(phrenPath, name);
  if (existing) {
    console.error(`Store "${name}" already exists at ${existing.path}`);
    process.exit(1);
  }

  const storesDir = path.join(path.dirname(phrenPath), ".phren-stores");
  const storePath = path.join(storesDir, name);

  if (fs.existsSync(storePath)) {
    console.error(`Directory already exists: ${storePath}`);
    process.exit(1);
  }

  // Create the team store directory
  fs.mkdirSync(storePath, { recursive: true });

  // Write .phren-team.yaml
  const bootstrap: TeamBootstrap = {
    name,
    description: description || `${name} team knowledge`,
    default_role: "team",
  };
  atomicWriteText(
    path.join(storePath, ".phren-team.yaml"),
    `name: ${bootstrap.name}\ndescription: ${bootstrap.description}\ndefault_role: team\n`,
  );

  // Write .gitignore
  atomicWriteText(
    path.join(storePath, ".gitignore"),
    ".runtime/\n.sessions/\n*.lock\n",
  );

  // Create global directory with starter files
  const globalDir = path.join(storePath, "global");
  fs.mkdirSync(globalDir, { recursive: true });
  atomicWriteText(
    path.join(globalDir, "CLAUDE.md"),
    `# ${name} Team Store\n\nShared knowledge for the ${name} team.\n`,
  );
  atomicWriteText(
    path.join(globalDir, "FINDINGS.md"),
    `# global findings\n`,
  );

  // Initialize git repo
  execFileSync("git", ["init"], {
    cwd: storePath,
    stdio: "pipe",
    timeout: EXEC_TIMEOUT_MS,
  });

  // Initial commit
  execFileSync("git", ["add", "-A"], { cwd: storePath, stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
  execFileSync("git", ["commit", "-m", "phren: initialize team store"], {
    cwd: storePath,
    stdio: "pipe",
    timeout: EXEC_TIMEOUT_MS,
  });

  // Add remote if provided
  if (remote) {
    execFileSync("git", ["remote", "add", "origin", remote], {
      cwd: storePath,
      stdio: "pipe",
      timeout: EXEC_TIMEOUT_MS,
    });
    try {
      execFileSync("git", ["push", "-u", "origin", "main"], {
        cwd: storePath,
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      console.log(`  Pushed to ${remote}`);
    } catch {
      // Try HEAD branch name
      try {
        execFileSync("git", ["push", "-u", "origin", "HEAD"], {
          cwd: storePath,
          stdio: "pipe",
          timeout: EXEC_TIMEOUT_MS,
        });
        console.log(`  Pushed to ${remote}`);
      } catch {
        console.log(`  Remote added but push failed. Push manually: cd ${storePath} && git push -u origin main`);
      }
    }
  }

  // Register in primary store's stores.yaml
  const entry: StoreEntry = {
    id: generateStoreId(),
    name,
    path: storePath,
    role: "team",
    sync: "managed-git",
    ...(remote ? { remote } : {}),
  };
  addStoreToRegistry(phrenPath, entry);

  console.log(`\nCreated team store: ${name}`);
  console.log(`  Path: ${storePath}`);
  console.log(`  Role: team`);
  console.log(`  ID: ${entry.id}`);
  if (!remote) {
    console.log(`\nNext: add a remote and push`);
    console.log(`  cd ${storePath}`);
    console.log(`  git remote add origin <your-git-url>`);
    console.log(`  git push -u origin main`);
  }
  console.log(`\nAdd projects: phren team add-project ${name} <project-name>`);
}

// ── phren team join <url> [--name <name>] ───────────────────────────────────

async function handleTeamJoin(args: string[]): Promise<void> {
  const phrenPath = getPhrenPath();
  const positional = getPositionalArgs(args, ["--name"]);
  const remote = positional[0];
  const nameOverride = getOptionValue(args, "--name");

  if (!remote) {
    console.error("Usage: phren team join <git-url> [--name <name>]");
    process.exit(1);
  }

  const storesDir = path.join(path.dirname(phrenPath), ".phren-stores");
  // Infer name from URL if not provided
  const inferredName = nameOverride || path.basename(remote, ".git").toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  if (!isValidProjectName(inferredName)) {
    console.error(`Invalid store name: "${inferredName}". Use --name to specify a valid name.`);
    process.exit(1);
  }

  const existing = findStoreByName(phrenPath, inferredName);
  if (existing) {
    console.error(`Store "${inferredName}" already exists at ${existing.path}`);
    process.exit(1);
  }

  const storePath = path.join(storesDir, inferredName);
  if (fs.existsSync(storePath)) {
    console.error(`Directory already exists: ${storePath}`);
    process.exit(1);
  }

  // Clone the remote
  console.log(`Cloning ${remote}...`);
  fs.mkdirSync(storesDir, { recursive: true });
  execFileSync("git", ["clone", "--", remote, storePath], {
    stdio: "inherit",
    timeout: 60_000,
  });

  // Read .phren-team.yaml if present
  const bootstrap = readTeamBootstrap(storePath);
  const finalName = bootstrap?.name || inferredName;
  const finalRole = bootstrap?.default_role === "primary" ? "team" : (bootstrap?.default_role || "team");

  const entry: StoreEntry = {
    id: generateStoreId(),
    name: finalName,
    path: storePath,
    role: finalRole,
    sync: finalRole === "readonly" ? "pull-only" : "managed-git",
    remote,
  };
  addStoreToRegistry(phrenPath, entry);

  console.log(`\nJoined team store: ${finalName}`);
  console.log(`  Path: ${storePath}`);
  console.log(`  Role: ${finalRole}`);
  console.log(`  ID: ${entry.id}`);
  if (bootstrap?.description) {
    console.log(`  Description: ${bootstrap.description}`);
  }
}

// ── phren team add-project <store> <project> ────────────────────────────────

async function handleTeamAddProject(args: string[]): Promise<void> {
  const phrenPath = getPhrenPath();
  const positional = getPositionalArgs(args, []);
  const storeName = positional[0];
  const projectName = positional[1];

  if (!storeName || !projectName) {
    console.error("Usage: phren team add-project <store-name> <project-name>");
    process.exit(1);
  }

  if (!isValidProjectName(projectName)) {
    console.error(`Invalid project name: "${projectName}"`);
    process.exit(1);
  }

  const store = findStoreByName(phrenPath, storeName);
  if (!store) {
    console.error(`Store "${storeName}" not found. Run 'phren store list' to see available stores.`);
    process.exit(1);
  }
  if (store.role === "readonly") {
    console.error(`Store "${storeName}" is read-only. Cannot add projects.`);
    process.exit(1);
  }

  // Create project directory in the store
  const projectDir = path.join(store.path, projectName);
  const journalDir = path.join(projectDir, "journal");
  fs.mkdirSync(journalDir, { recursive: true });

  // Scaffold project files
  if (!fs.existsSync(path.join(projectDir, "FINDINGS.md"))) {
    atomicWriteText(path.join(projectDir, "FINDINGS.md"), `# ${projectName} findings\n`);
  }
  if (!fs.existsSync(path.join(projectDir, "tasks.md"))) {
    atomicWriteText(path.join(projectDir, "tasks.md"), `# ${projectName} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
  }
  if (!fs.existsSync(path.join(projectDir, "summary.md"))) {
    atomicWriteText(path.join(projectDir, "summary.md"), `# ${projectName}\n**What:** \n`);
  }

  // Update store's project claims in registry
  const currentProjects = store.projects || [];
  if (!currentProjects.includes(projectName)) {
    updateStoreProjects(phrenPath, storeName, [...currentProjects, projectName]);
  }

  console.log(`Added project "${projectName}" to team store "${storeName}"`);
  console.log(`  Path: ${projectDir}`);
  console.log(`  Journal: ${journalDir}`);
  console.log(`\nWrites to "${projectName}" will now route to "${storeName}" automatically.`);
}

// ── phren team list ─────────────────────────────────────────────────────────

async function handleTeamList(): Promise<void> {
  const phrenPath = getPhrenPath();
  const { resolveAllStores } = await import("../store-registry.js");
  const stores = resolveAllStores(phrenPath);
  const teamStores = stores.filter((s) => s.role === "team");

  if (teamStores.length === 0) {
    console.log("No team stores registered.");
    console.log("\nCreate one:  phren team init <name> [--remote <url>]");
    console.log("Join one:    phren team join <git-url>");
    return;
  }

  console.log(`${teamStores.length} team store(s):\n`);
  for (const store of teamStores) {
    const exists = fs.existsSync(store.path);
    console.log(`  ${store.name} (${store.id}) ${exists ? "" : "[missing]"}`);
    console.log(`    path: ${store.path}`);
    if (store.remote) console.log(`    remote: ${store.remote}`);
    if (store.projects?.length) console.log(`    projects: ${store.projects.join(", ")}`);
    console.log();
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function handleTeamNamespace(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "init":
      return handleTeamInit(subArgs);
    case "join":
      return handleTeamJoin(subArgs);
    case "add-project":
      return handleTeamAddProject(subArgs);
    case "list":
      return handleTeamList();
    default:
      console.log(`phren team — manage shared team stores

  phren team init <name> [--remote <url>]     Create a new team store
  phren team join <git-url> [--name <name>]   Join an existing team store
  phren team add-project <store> <project>    Add a project to a team store
  phren team list                             List team stores
`);
      if (subcommand) {
        console.error(`Unknown subcommand: ${subcommand}`);
        process.exit(1);
      }
  }
}
