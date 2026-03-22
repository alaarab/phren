/**
 * Project-local init mode: creates a .phren directory inside the workspace.
 */
import * as fs from "fs";
import * as path from "path";
import {
  atomicWriteText,
  debugLog,
  readRootManifest,
  writeRootManifest,
} from "./shared.js";
import { errorMessage } from "./utils.js";
import {
  configureVSCode,
  logMcpTargetStatus,
} from "./init/config.js";
import {
  writeInstallPreferences,
  readInstallPreferences,
} from "./init/preferences.js";
import {
  ensureGovernanceFiles,
  repairPreexistingInstall,
  runPostInitVerify,
  bootstrapFromExisting,
  detectProjectDir,
} from "./init/setup.js";
import {
  getProjectOwnershipDefault,
  type ProjectOwnershipMode,
} from "./project-config.js";
import { VERSION, log } from "./init/shared.js";
import { applyOnboardingPreferences } from "./init-env.js";
import type { InitOptions } from "./init-types.js";

export async function runProjectLocalInit(opts: InitOptions = {}): Promise<void> {
  const detectedRoot = detectProjectDir(process.cwd(), path.join(process.cwd(), ".phren")) || process.cwd();
  const hasWorkspaceMarker =
    fs.existsSync(path.join(detectedRoot, ".git")) ||
    fs.existsSync(path.join(detectedRoot, "CLAUDE.md")) ||
    fs.existsSync(path.join(detectedRoot, "AGENTS.md")) ||
    fs.existsSync(path.join(detectedRoot, ".claude", "CLAUDE.md"));
  if (!hasWorkspaceMarker) {
    throw new Error("project-local mode must be run inside a repo or project root");
  }

  const workspaceRoot = path.resolve(detectedRoot);
  const phrenPath = path.join(workspaceRoot, ".phren");
  const existingManifest = readRootManifest(phrenPath);
  if (existingManifest && existingManifest.installMode !== "project-local") {
    throw new Error(`Refusing to reuse non-local phren root at ${phrenPath}`);
  }

  const ownershipDefault = opts.projectOwnershipDefault
    ?? (existingManifest ? getProjectOwnershipDefault(phrenPath) : "detached");
  if (!existingManifest && !opts.projectOwnershipDefault) {
    opts.projectOwnershipDefault = ownershipDefault;
  }
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : true;
  const projectName = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  if (opts.dryRun) {
    log("\nInit dry run. No files will be written.\n");
    log(`Mode: project-local`);
    log(`Workspace root: ${workspaceRoot}`);
    log(`Phren root: ${phrenPath}`);
    log(`Project: ${projectName}`);
    log(`VS Code workspace MCP: ${mcpEnabled ? "on" : "off"}`);
    log(`Hooks: unsupported in project-local mode`);
    log("");
    return;
  }

  fs.mkdirSync(phrenPath, { recursive: true });
  writeRootManifest(phrenPath, {
    version: 1,
    installMode: "project-local",
    syncMode: "workspace-git",
    workspaceRoot,
    primaryProject: projectName,
  });
  ensureGovernanceFiles(phrenPath);
  repairPreexistingInstall(phrenPath);
  fs.mkdirSync(path.join(phrenPath, "global", "skills"), { recursive: true });
  fs.mkdirSync(path.join(phrenPath, ".runtime"), { recursive: true });
  fs.mkdirSync(path.join(phrenPath, ".sessions"), { recursive: true });
  if (!fs.existsSync(path.join(phrenPath, ".gitignore"))) {
    atomicWriteText(
      path.join(phrenPath, ".gitignore"),
      [
        ".runtime/",
        ".sessions/",
        "*.lock",
        "*.tmp-*",
        "",
      ].join("\n")
    );
  }
  if (!fs.existsSync(path.join(phrenPath, "global", "CLAUDE.md"))) {
    atomicWriteText(
      path.join(phrenPath, "global", "CLAUDE.md"),
      "# Global Context\n\nRepo-local Phren instructions shared across this workspace.\n"
    );
  }

  const created = bootstrapFromExisting(phrenPath, workspaceRoot, { ownership: ownershipDefault });
  applyOnboardingPreferences(phrenPath, opts);
  writeInstallPreferences(phrenPath, {
    mcpEnabled,
    hooksEnabled: false,
    skillsScope: opts.skillsScope ?? "global",
    installedVersion: VERSION,
  });

  try {
    const vscodeResult = configureVSCode(phrenPath, { mcpEnabled, scope: "workspace" });
    logMcpTargetStatus("VS Code", vscodeResult, existingManifest ? "Updated" : "Configured");
  } catch (err: unknown) {
    debugLog(`configureVSCode(workspace) failed: ${errorMessage(err)}`);
  }

  log(`\n${existingManifest ? "Updated" : "Created"} project-local phren at ${phrenPath}`);
  log(`  Workspace root: ${workspaceRoot}`);
  log(`  Project: ${created.project}`);
  log(`  Ownership: ${created.ownership}`);
  log(`  Sync mode: workspace-git`);
  log(`  Hooks: off (unsupported in project-local mode)`);
  log(`  VS Code MCP: ${mcpEnabled ? "workspace on" : "workspace off"}`);

  const verify = runPostInitVerify(phrenPath);
  log(`\nVerifying setup...`);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }
}
