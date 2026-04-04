/** CLI handler for `phren store` subcommands. */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getPhrenPath } from "../../shared.js";
import { isValidProjectName, errorMessage } from "../../utils.js";
import {
  resolveAllStores,
  addStoreToRegistry,
  removeStoreFromRegistry,
  generateStoreId,
  readTeamBootstrap,
  type StoreEntry,
} from "../../store-registry.js";
import { getOptionValue } from "./utils.js";

function printStoreUsage() {
  console.log("Usage:");
  console.log("  phren store list                        List registered stores");
  console.log("  phren store add <name> --remote <url>   Add a team store");
  console.log("  phren store remove <name>               Remove a store (local only)");
  console.log("  phren store sync                        Pull all stores");
  console.log("  phren store activity [--limit N]         Recent team findings");
  console.log("  phren store subscribe <name> <project...>   Subscribe store to projects");
  console.log("  phren store unsubscribe <name> <project...> Unsubscribe store from projects");
}

function countStoreProjects(store: StoreEntry): number {
  if (!fs.existsSync(store.path)) return 0;
  try {
    const storeRegistry = require("../../store-registry.js");
    return storeRegistry.getStoreProjectDirs(store).length;
  } catch {
    return 0;
  }
}

function readHealthForStore(storePath: string): string | null {
  try {
    const healthPath = path.join(storePath, ".runtime", "health.json");
    if (!fs.existsSync(healthPath)) return null;
    const raw = JSON.parse(fs.readFileSync(healthPath, "utf8"));
    const lastSync = raw?.lastSync;
    if (!lastSync) return null;
    const parts: string[] = [];
    if (lastSync.lastPullStatus) parts.push(`pull=${lastSync.lastPullStatus}`);
    if (lastSync.lastPushStatus) parts.push(`push=${lastSync.lastPushStatus}`);
    if (lastSync.lastSuccessfulPullAt) parts.push(`at=${lastSync.lastSuccessfulPullAt.slice(0, 16)}`);
    return parts.join(", ") || null;
  } catch {
    return null;
  }
}

export async function handleStoreNamespace(args: string[]) {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printStoreUsage();
    return;
  }

  const phrenPath = getPhrenPath();

  if (subcommand === "list") {
    const stores = resolveAllStores(phrenPath);
    if (stores.length === 0) {
      console.log("No stores registered.");
      return;
    }

    console.log(`${stores.length} store(s):\n`);
    for (const store of stores) {
      const exists = fs.existsSync(store.path) ? "ok" : "MISSING";
      const syncInfo = store.remote ?? "(local)";
      const projectCount = countStoreProjects(store);
      console.log(`  ${store.name} (${store.role})`);
      console.log(`    id:       ${store.id}`);
      console.log(`    path:     ${store.path} [${exists}]`);
      console.log(`    remote:   ${syncInfo}`);
      console.log(`    sync:     ${store.sync}`);
      console.log(`    projects: ${projectCount}`);

      const health = readHealthForStore(store.path);
      if (health) {
        console.log(`    last sync: ${health}`);
      }
      console.log();
    }
    return;
  }

  if (subcommand === "add") {
    const name = args[1];
    if (!name) {
      console.error("Usage: phren store add <name> --remote <url> [--role team|readonly]");
      process.exit(1);
    }

    if (!isValidProjectName(name)) {
      console.error(`Invalid store name: "${name}". Use lowercase letters, numbers, and hyphens.`);
      process.exit(1);
    }

    const remote = getOptionValue(args.slice(2), "--remote");
    if (!remote) {
      console.error("--remote <url> is required. Provide the git clone URL for the team store.");
      process.exit(1);
    }

    if (remote.startsWith("-")) {
      console.error(`Invalid remote URL: "${remote}". URLs must not start with "-".`);
      process.exit(1);
    }

    const roleArg = getOptionValue(args.slice(2), "--role") ?? "team";
    if (roleArg !== "team" && roleArg !== "readonly") {
      console.error(`Invalid role: "${roleArg}". Use "team" or "readonly".`);
      process.exit(1);
    }

    const storesDir = path.join(path.dirname(phrenPath), ".phren-stores");
    const storePath = path.join(storesDir, name);

    if (fs.existsSync(storePath)) {
      console.error(`Directory already exists: ${storePath}`);
      process.exit(1);
    }

    console.log(`Cloning ${remote} into ${storePath}...`);
    try {
      fs.mkdirSync(storesDir, { recursive: true });
      execFileSync("git", ["clone", "--", remote, storePath], {
        stdio: "inherit",
        timeout: 60_000,
      });
    } catch (err: unknown) {
      console.error(`Clone failed: ${errorMessage(err)}`);
      process.exit(1);
    }

    const bootstrap = readTeamBootstrap(storePath);
    const storeName = bootstrap?.name ?? name;
    const storeRole = bootstrap?.default_role ?? roleArg;

    const entry: StoreEntry = {
      id: generateStoreId(),
      name: storeName,
      path: storePath,
      role: storeRole === "primary" ? "team" : storeRole,
      sync: storeRole === "readonly" ? "pull-only" : "managed-git",
      remote,
    };

    try {
      addStoreToRegistry(phrenPath, entry);
    } catch (err: unknown) {
      console.error(`Failed to register store: ${errorMessage(err)}`);
      process.exit(1);
    }

    console.log(`\nStore "${storeName}" added (${entry.role}).`);
    console.log(`  id:   ${entry.id}`);
    console.log(`  path: ${storePath}`);
    return;
  }

  if (subcommand === "remove") {
    const name = args[1];
    if (!name) {
      console.error("Usage: phren store remove <name>");
      process.exit(1);
    }

    try {
      const removed = removeStoreFromRegistry(phrenPath, name);
      console.log(`Store "${name}" removed from registry.`);
      console.log(`  Local directory preserved at: ${removed.path}`);
      console.log(`  To delete: rm -rf "${removed.path}"`);
    } catch (err: unknown) {
      console.error(`${errorMessage(err)}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === "activity") {
    const stores = resolveAllStores(phrenPath);
    const teamStores = stores.filter((s) => s.role === "team");
    if (teamStores.length === 0) {
      console.log("No team stores registered. Add one with: phren store add <name> --remote <url>");
      return;
    }

    const { readTeamJournalEntries } = await import("../../finding/journal.js");
    const limit = Number(getOptionValue(args.slice(1), "--limit") ?? "20");
    const allEntries: Array<{ store: string; project: string; date: string; actor: string; entry: string }> = [];

    for (const store of teamStores) {
      if (!fs.existsSync(store.path)) continue;
      const { getStoreProjectDirs } = await import("../../store-registry.js");
      const projectDirs = getStoreProjectDirs(store);
      for (const dir of projectDirs) {
        const projectName = path.basename(dir);
        const journalEntries = readTeamJournalEntries(store.path, projectName);
        for (const je of journalEntries) {
          for (const entry of je.entries) {
            allEntries.push({ store: store.name, project: projectName, date: je.date, actor: je.actor, entry });
          }
        }
      }
    }

    allEntries.sort((a, b) => b.date.localeCompare(a.date));
    const capped = allEntries.slice(0, limit);

    if (capped.length === 0) {
      console.log("No team activity yet.");
      return;
    }

    console.log(`Team activity (${capped.length}/${allEntries.length}):\n`);
    let lastDate = "";
    for (const e of capped) {
      if (e.date !== lastDate) {
        console.log(`## ${e.date}`);
        lastDate = e.date;
      }
      console.log(`  [${e.store}/${e.project}] ${e.actor}: ${e.entry}`);
    }
    return;
  }

  if (subcommand === "sync") {
    const stores = resolveAllStores(phrenPath);
    let hasErrors = false;

    for (const store of stores) {
      if (!fs.existsSync(store.path)) {
        console.log(`  ${store.name}: SKIP (path missing)`);
        continue;
      }

      const gitDir = path.join(store.path, ".git");
      if (!fs.existsSync(gitDir)) {
        console.log(`  ${store.name}: SKIP (not a git repo)`);
        continue;
      }

      try {
        execFileSync("git", ["pull", "--rebase", "--quiet"], {
          cwd: store.path,
          stdio: "pipe",
          timeout: 30_000,
        });
        console.log(`  ${store.name}: ok`);
      } catch (err: unknown) {
        console.log(`  ${store.name}: FAILED (${errorMessage(err).split("\n")[0]})`);
        hasErrors = true;
      }
    }

    if (hasErrors) {
      console.error("\nSome stores failed to sync. Run 'phren doctor' for details.");
    }
    return;
  }

  if (subcommand === "subscribe") {
    const storeName = args[1];
    const projects = args.slice(2);
    if (!storeName || projects.length === 0) {
      console.error("Usage: phren store subscribe <store-name> <project1> [project2...]");
      process.exit(1);
    }
    try {
      const { subscribeStoreProjects } = await import("../../store-registry.js");
      subscribeStoreProjects(phrenPath, storeName, projects);
      console.log(`Added ${projects.length} project(s) to "${storeName}"`);
    } catch (err: unknown) {
      console.error(`Failed to subscribe: ${errorMessage(err)}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === "unsubscribe") {
    const storeName = args[1];
    const projects = args.slice(2);
    if (!storeName || projects.length === 0) {
      console.error("Usage: phren store unsubscribe <store-name> <project1> [project2...]");
      process.exit(1);
    }
    try {
      const { unsubscribeStoreProjects } = await import("../../store-registry.js");
      unsubscribeStoreProjects(phrenPath, storeName, projects);
      console.log(`Removed ${projects.length} project(s) from "${storeName}"`);
    } catch (err: unknown) {
      console.error(`Failed to unsubscribe: ${errorMessage(err)}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown store subcommand: ${subcommand}`);
  printStoreUsage();
  process.exit(1);
}
