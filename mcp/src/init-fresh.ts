/**
 * Fresh install logic: copy starter, scaffold project, write initial config.
 */
import * as fs from "fs";
import * as path from "path";
import {
  atomicWriteText,
  debugLog,
  hookConfigPath,
  writeRootManifest,
} from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { getMachineName, persistMachineName } from "./machine-identity.js";
import {
  readInstallPreferences,
  writeInstallPreferences,
} from "./init/preferences.js";
import {
  ensureGovernanceFiles,
  repairPreexistingInstall,
  runPostInitVerify,
  applyStarterTemplateUpdates,
  listTemplates,
  applyTemplate,
  ensureProjectScaffold,
  ensureLocalGitRepo,
  updateMachinesYaml,
  detectProjectDir,
} from "./init/setup.js";
import { getWorkflowPolicy } from "./shared/governance.js";
import { addProjectToProfile } from "./profile-store.js";
import { STARTER_DIR, VERSION, log, confirmPrompt } from "./init/shared.js";
import { configureMcpTargets } from "./init-mcp.js";
import { configureHooksIfEnabled } from "./init-hooks.js";
import {
  applyOnboardingPreferences,
  writeWalkthroughEnvDefaults,
  collectRepairedAssetLabels,
} from "./init-env.js";
import { warmSemanticSearch } from "./init-semantic.js";
import { bootstrapProject } from "./init-bootstrap.js";
import { logger } from "./logger.js";
import type { InitOptions, SkillsScope } from "./init-types.js";
import type { InitProjectDomain } from "./init/setup.js";
import type { ProjectOwnershipMode } from "./project-config.js";

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (src === STARTER_DIR && entry.isDirectory() && ["my-api", "my-frontend", "my-first-project"].includes(entry.name)) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function runFreshInstall(
  phrenPath: string,
  opts: InitOptions,
  params: {
    mcpEnabled: boolean;
    hooksEnabled: boolean;
    skillsScope: SkillsScope;
    ownershipDefault: string;
    syncIntent: "sync" | "local";
    shouldBootstrapCurrentProject: boolean;
    bootstrapOwnership: string;
  },
): Promise<void> {
  const {
    mcpEnabled,
    hooksEnabled,
    skillsScope,
    ownershipDefault,
    syncIntent,
    shouldBootstrapCurrentProject,
    bootstrapOwnership,
  } = params;

  log("\nSetting up phren...\n");

  const walkthroughProject = opts._walkthroughProject;
  if (walkthroughProject) {
    if (!walkthroughProject.trim()) {
      console.error("Error: project name cannot be empty.");
      process.exit(1);
    }
    if (walkthroughProject.length > 100) {
      console.error("Error: project name must be 100 characters or fewer.");
      process.exit(1);
    }
    if (!isValidProjectName(walkthroughProject)) {
      console.error(`Error: invalid project name "${walkthroughProject}". Use lowercase letters, numbers, and hyphens.`);
      process.exit(1);
    }
  }

  const cwdProjectPath = !walkthroughProject ? detectProjectDir(process.cwd(), phrenPath) : null;
  const useTemplateProject = Boolean(walkthroughProject) || Boolean(opts.template);
  const firstProjectName = walkthroughProject || "my-first-project";
  const firstProjectDomain: InitProjectDomain = opts._walkthroughDomain ?? "software";

  if (fs.existsSync(STARTER_DIR)) {
    copyDir(STARTER_DIR, phrenPath);
    writeRootManifest(phrenPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    if (useTemplateProject) {
      const targetProject = walkthroughProject || firstProjectName;
      const projectDir = path.join(phrenPath, targetProject);
      const templateApplied = Boolean(opts.template && applyTemplate(projectDir, opts.template, targetProject));
      if (templateApplied) {
        log(`  Applied "${opts.template}" template to ${targetProject}`);
      }
      ensureProjectScaffold(projectDir, targetProject, firstProjectDomain, opts._walkthroughInferredScaffold);

      const targetProfile = opts.profile || "default";
      const addToProfile = addProjectToProfile(phrenPath, targetProfile, targetProject);
      if (!addToProfile.ok) {
        debugLog(`fresh init addProjectToProfile failed for ${targetProfile}/${targetProject}: ${addToProfile.error}`);
      }

      if (opts.template && !templateApplied) {
        log(`  Template "${opts.template}" not found. Available: ${listTemplates().join(", ") || "none"}`);
      }
      log(`  Seeded project "${targetProject}"`);
    }
    log(`  Created phren v${VERSION} \u2192 ${phrenPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    writeRootManifest(phrenPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    fs.mkdirSync(path.join(phrenPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    atomicWriteText(
      path.join(phrenPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    if (useTemplateProject) {
      const projectDir = path.join(phrenPath, firstProjectName);
      if (opts.template && applyTemplate(projectDir, opts.template, firstProjectName)) {
        log(`  Applied "${opts.template}" template to ${firstProjectName}`);
      }
      ensureProjectScaffold(projectDir, firstProjectName, firstProjectDomain, opts._walkthroughInferredScaffold);
    }
    const profileName = opts.profile || "default";
    const profileProjects = useTemplateProject
      ? `  - global\n  - ${firstProjectName}`
      : `  - global`;
    atomicWriteText(
      path.join(phrenPath, "profiles", `${profileName}.yaml`),
      `name: ${profileName}\ndescription: Default profile\nprojects:\n${profileProjects}\n`
    );
  }

  // Bootstrap CWD project if opted in
  if (cwdProjectPath && shouldBootstrapCurrentProject) {
    bootstrapProject(phrenPath, cwdProjectPath, opts.profile, bootstrapOwnership as ProjectOwnershipMode, "Added current project");
  }

  // Persist machine and config
  const effectiveMachine = opts.machine?.trim() || getMachineName();
  persistMachineName(effectiveMachine);
  updateMachinesYaml(phrenPath, effectiveMachine, opts.profile);
  ensureGovernanceFiles(phrenPath);
  const repaired = repairPreexistingInstall(phrenPath);
  applyOnboardingPreferences(phrenPath, opts);
  const localGitRepo = ensureLocalGitRepo(phrenPath);
  log(`  Updated machines.yaml with machine "${effectiveMachine}"`);
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);
  log(`  Default project ownership: ${ownershipDefault}`);
  log(`  Task mode: ${getWorkflowPolicy(phrenPath).taskMode}`);
  log(`  Git repo: ${localGitRepo.detail}`);
  if (repaired.removedLegacyProjects > 0) {
    log(`  Removed ${repaired.removedLegacyProjects} legacy starter project entr${repaired.removedLegacyProjects === 1 ? "y" : "ies"} from profiles.`);
  }
  const repairedAssets = collectRepairedAssetLabels(repaired);
  if (repairedAssets.length > 0) {
    log(`  Recreated missing generated assets: ${repairedAssets.join(", ")}`);
  }

  // Confirmation prompt before writing agent config
  if (!opts.yes) {
    const settingsPath = hookConfigPath("claude");
    log(`\nWill modify:`);
    log(`  ${settingsPath}  (add MCP server + hooks)`);

    const confirmed = await confirmPrompt("\nProceed?");
    if (!confirmed) {
      log("Aborted.");
      return;
    }
  }

  // Configure MCP and hooks
  configureMcpTargets(phrenPath, { mcpEnabled, hooksEnabled }, "Configured");
  configureHooksIfEnabled(phrenPath, hooksEnabled, "Configured");

  writeInstallPreferences(phrenPath, { mcpEnabled, hooksEnabled, skillsScope, installedVersion: VERSION, syncIntent });

  // Post-init verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(phrenPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  log(`\nWhat was created:`);
  log(`  ${phrenPath}/global/CLAUDE.md    Global instructions loaded in every session`);
  log(`  ${phrenPath}/global/skills/      Phren slash commands`);
  log(`  ${phrenPath}/profiles/           Machine-to-project mappings`);
  log(`  ${phrenPath}/.config/        Memory quality settings and config`);

  // Ollama status summary (skip if already covered in walkthrough)
  const walkthroughCoveredOllama = Boolean(process.env._PHREN_WALKTHROUGH_OLLAMA_SKIP) || !opts.yes;
  if (!walkthroughCoveredOllama) {
    try {
      const { checkOllamaStatus } = await import("./shared/ollama.js");
      const status = await checkOllamaStatus();
      if (status === "ready") {
        log("\n  Semantic search: Ollama + nomic-embed-text ready.");
      } else if (status === "no_model") {
        log("\n  Semantic search: Ollama running, but nomic-embed-text not pulled.");
        log("  Run: ollama pull nomic-embed-text");
      } else if (status === "not_running") {
        log("\n  Tip: Install Ollama for semantic search (optional).");
        log("  https://ollama.com → then: ollama pull nomic-embed-text");
        log("  (Set PHREN_OLLAMA_URL=off to hide this message)");
      }
    } catch (err: unknown) {
      logger.debug("init ollamaInstallHint", errorMessage(err));
    }
  }

  for (const envLabel of writeWalkthroughEnvDefaults(phrenPath, opts)) {
    log(`  ${envLabel}`);
  }

  if (opts._walkthroughSemanticSearch) {
    log(`\nWarming semantic search...`);
    try {
      log(`  ${await warmSemanticSearch(phrenPath, opts.profile)}`);
    } catch (err: unknown) {
      log(`  Semantic search warmup failed: ${errorMessage(err)}`);
    }
  }

  log(`\n\x1b[95m◆\x1b[0m phren initialized`);
  log(`\nNext steps:`);
  let step = 1;
  log(`  ${step++}. Start a new Claude session in your project directory — phren injects context automatically`);
  log(`  ${step++}. Run \`npx phren doctor\` to verify everything is wired correctly`);
  log(`  ${step++}. Change defaults anytime: \`npx phren config project-ownership\`, \`npx phren config workflow\`, \`npx phren config proactivity.findings\`, \`npx phren config proactivity.tasks\``);

  const gh = opts._walkthroughGithub;
  if (gh) {
    const remote = gh.username
      ? `git@github.com:${gh.username}/${gh.repo}.git`
      : `git@github.com:YOUR_USERNAME/${gh.repo}.git`;
    log(`  ${step++}. Push your phren to GitHub (private repo recommended):`);
    log(`     cd ${phrenPath}`);
    log(`     git add . && git commit -m "Initial phren setup"`);
    if (gh.username) {
      log(`     gh repo create ${gh.username}/${gh.repo} --private --source=. --push`);
      log(`     # or manually: git remote add origin ${remote} && git push -u origin main`);
    } else {
      log(`     git remote add origin ${remote}`);
      log(`     git push -u origin main`);
    }
  } else {
    log(`  ${step++}. Push to GitHub for cross-machine sync (private repo recommended):`);
    log(`     cd ${phrenPath}`);
    log(`     git add . && git commit -m "Initial phren setup"`);
    log(`     git remote add origin git@github.com:YOUR_USERNAME/my-phren.git`);
    log(`     git push -u origin main`);
  }

  log(`  ${step++}. Add more projects: cd ~/your-project && npx phren add`);

  if (!mcpEnabled) {
    log(`  ${step++}. Turn MCP on: npx phren mcp-mode on`);
  }
  log(`  ${step++}. After your first week, run phren-discover to surface gaps in your project knowledge`);
  log(`  ${step++}. After working across projects, run phren-consolidate to find cross-project patterns`);
  log(`\n  Read ${phrenPath}/README.md for a guided tour of each file.`);

  log(``);
}
