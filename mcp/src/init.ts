/**
 * CLI orchestrator for cortex init, mcp-mode, hooks-mode, and uninstall.
 * Delegates to focused helpers in init-config, init-setup, and init-preferences.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import { execFileSync } from "child_process";
import { configureAllHooks } from "./hooks.js";
import { getMachineName, persistMachineName } from "./machine-identity.js";
import { debugLog, isRecord, hookConfigPath, homeDir, homePath } from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import {
  codexJsonCandidates,
  copilotMcpCandidates,
  cursorMcpCandidates,
  vscodeMcpCandidates,
} from "./provider-adapters.js";

// Re-export everything consumers need from the helper modules
export type { McpConfigStatus, McpRootKey, ToolStatus } from "./init-config.js";
export {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  resetVSCodeProbeCache,
  patchJsonFile,
} from "./init-config.js";

export type { InstallPreferences } from "./init-preferences.js";
export {
  getMcpEnabledPreference,
  setMcpEnabledPreference,
  getHooksEnabledPreference,
  setHooksEnabledPreference,
} from "./init-preferences.js";

export {
  PROACTIVITY_LEVELS,
  type ProactivityLevel,
  getProactivityLevel,
  getProactivityLevelForFindings,
  getProactivityLevelForBacklog,
} from "./proactivity.js";

export type { PostInitCheck } from "./init-setup.js";
export {
  ensureGovernanceFiles,
  runPostInitVerify,
  getVerifyOutcomeNote,
  listTemplates,
  detectProjectDir,
  isProjectTracked,
} from "./init-setup.js";

// Imports from helpers (used internally in this file)
import {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  removeMcpServerAtPath,
  removeTomlMcpServer,
  isCortexCommand,
  patchJsonFile,
} from "./init-config.js";
import type { ToolStatus } from "./init-config.js";

import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  setMcpEnabledPreference,
  setHooksEnabledPreference,
  writeInstallPreferences,
  readInstallPreferences,
} from "./init-preferences.js";

import {
  ensureGovernanceFiles,
  runPostInitVerify,
  applyStarterTemplateUpdates,
  listTemplates,
  applyTemplate,
  bootstrapFromExisting,
  updateMachinesYaml,
  detectProjectDir,
  isProjectTracked,
} from "./init-setup.js";

import { DEFAULT_CORTEX_PATH, STARTER_DIR, VERSION, log, confirmPrompt } from "./init-shared.js";

export type McpMode = "on" | "off";

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

type HookMap = Partial<Record<"UserPromptSubmit" | "Stop" | "SessionStart" | "PostToolUse", HookEntry[]>> & Record<string, unknown>;

function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function parseVersion(version: string): { major: number; minor: number; patch: number; pre: string } {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, pre: "" };
  return {
    major: Number.parseInt(match[1], 10) || 0,
    minor: Number.parseInt(match[2], 10) || 0,
    patch: Number.parseInt(match[3], 10) || 0,
    pre: match[4] || "",
  };
}

/**
 * Compare two semver strings. Returns true when `current` is strictly newer
 * than `previous`. Pre-release versions (e.g. 1.2.3-rc.1) sort before the
 * corresponding release (1.2.3). Among pre-release tags, comparison is
 * lexicographic.
 */
export function isVersionNewer(current: string, previous?: string): boolean {
  if (!previous) return false;
  const c = parseVersion(current);
  const p = parseVersion(previous);
  if (c.major !== p.major) return c.major > p.major;
  if (c.minor !== p.minor) return c.minor > p.minor;
  if (c.patch !== p.patch) return c.patch > p.patch;
  if (c.pre && !p.pre) return false;
  if (!c.pre && p.pre) return true;
  return c.pre > p.pre;
}

export function parseMcpMode(raw?: string): McpMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  return undefined;
}

export interface InitOptions {
  machine?: string;
  profile?: string;
  mcp?: McpMode;
  hooks?: McpMode;
  applyStarterUpdate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  template?: string;
  /** Set by walkthrough to pass project name to init logic */
  _walkthroughProject?: string;
  /** Set by walkthrough for personalized GitHub next-steps output */
  _walkthroughGithub?: { username?: string; repo: string };
  /** Set by walkthrough when user enables auto-capture; triggers writing ~/.cortex/.env */
  _walkthroughAutoCapture?: boolean;
  /** Set by walkthrough when user opts into local semantic search */
  _walkthroughSemanticSearch?: boolean;
  /** Set by walkthrough when user enables LLM semantic dedup */
  _walkthroughSemanticDedup?: boolean;
  /** Set by walkthrough when user enables LLM conflict detection */
  _walkthroughSemanticConflict?: boolean;
  /** Set by walkthrough when user provides a git clone URL for existing cortex */
  _walkthroughCloneUrl?: string;
}

function normalizedBootstrapProjectName(projectPath: string): string {
  return path.basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function updateStarterProfiles(cortexPath: string, mutate: (projects: string[]) => string[]): void {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return;
  for (const pf of fs.readdirSync(profilesDir)) {
    if (!pf.endsWith(".yaml")) continue;
    const pfPath = path.join(profilesDir, pf);
    try {
      const parsed = yaml.load(fs.readFileSync(pfPath, "utf8"), { schema: yaml.CORE_SCHEMA });
      if (!isRecord(parsed) || !Array.isArray(parsed.projects)) continue;
      const projects = parsed.projects.map((project) => String(project));
      const nextProjects = mutate(projects);
      if (nextProjects.join("\n") === projects.join("\n")) continue;
      const tmpPath = `${pfPath}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, yaml.dump({ ...parsed, projects: nextProjects }, { lineWidth: 1000 }));
      fs.renameSync(tmpPath, pfPath);
    } catch (err: unknown) {
      debugLog(`updateStarterProfiles failed for ${pfPath}: ${errorMessage(err)}`);
    }
  }
}

function getPendingBootstrapTarget(cortexPath: string, opts: InitOptions): { path: string; mode: "explicit" | "detected" } | null {
  const cwdProject = detectProjectDir(process.cwd(), cortexPath);
  if (!cwdProject) return null;
  const projectName = normalizedBootstrapProjectName(cwdProject);
  if (isProjectTracked(cortexPath, projectName)) return null;
  return { path: cwdProject, mode: "detected" };
}

// Interactive walkthrough for first-time init
async function runWalkthrough(): Promise<{ machine: string; profile: string; mcp: McpMode; hooks: McpMode; ollamaEnabled: boolean; autoCaptureEnabled: boolean; semanticDedupEnabled: boolean; semanticConflictEnabled: boolean; githubUsername?: string; githubRepo?: string; cloneUrl?: string }> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  log("\nWelcome to cortex. Let's set up persistent memory for your AI agents.\n");
  log("We'll ask a few questions. Every option can be changed later.\n");

  log("─── Existing cortex? ──────────────────────────────────────────────────");
  log("If you've already set up cortex on another machine, paste the git");
  log("clone URL to pull your existing memory. Otherwise, press Enter.\n");
  const cloneAnswer = (await ask(`Clone URL (or Enter to skip): `)).trim();
  if (cloneAnswer) {
    rl.close();
    return { machine: getMachineName(), profile: "personal", mcp: "on", hooks: "on", ollamaEnabled: false, autoCaptureEnabled: false, semanticDedupEnabled: false, semanticConflictEnabled: false, cloneUrl: cloneAnswer };
  }

  log("");
  const defaultMachine = getMachineName();
  const machineAnswer = (await ask(`Machine name [${defaultMachine}]: `)).trim();
  const machine = machineAnswer || defaultMachine;

  const profileAnswer = (await ask(`Profile name [personal]: `)).trim();
  const profile = profileAnswer || "personal";

  log("\n─── MCP ────────────────────────────────────────────────────────────────");
  log("MCP mode registers cortex as a tool server so your AI agent can call it");
  log("directly: search memory, manage tasks, save findings, etc.");
  log("  Recommended for: Claude Code, Cursor, Copilot CLI, Codex");
  log("  Alternative: hooks-only mode (read-only context injection, any agent)");
  log("  Change later: npx @alaarab/cortex mcp-mode on|off");
  const mcpAnswer = (await ask(`Enable MCP? [Y/n]: `)).trim().toLowerCase();
  const mcp: McpMode = (mcpAnswer === "n" || mcpAnswer === "no") ? "off" : "on";

  log("\n─── Hooks ──────────────────────────────────────────────────────────────");
  log("Hooks run shell commands at session start, prompt submit, and session end.");
  log("  - SessionStart: git pull (keeps memory in sync across machines)");
  log("  - UserPromptSubmit: searches cortex and injects relevant context");
  log("  - Stop: commits and pushes any new findings after each response");
  log("  What they touch: ~/.claude/settings.json (hooks section only)");
  log("  Change later: npx @alaarab/cortex hooks-mode on|off");
  const hooksAnswer = (await ask(`Enable hooks? [Y/n]: `)).trim().toLowerCase();
  const hooks: McpMode = (hooksAnswer === "n" || hooksAnswer === "no") ? "off" : "on";

  log("\n─── Semantic search (optional) ─────────────────────────────────────────");
  log("Cortex can use a local embedding model for semantic (fuzzy) search via Ollama.");
  log("  Best fit: paraphrase-heavy or weak-lexical queries.");
  log("  Skip it if you mostly search by filenames, symbols, commands, or exact phrases.");
  log("  - Model: nomic-embed-text (274 MB, one-time download)");
  log("  - Ollama runs locally, no cloud, no cost");
  log("  - Falls back to FTS5 keyword search if disabled or unavailable");
  log("  Change later: set CORTEX_OLLAMA_URL=off to disable");
  let ollamaEnabled = false;
  try {
    const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl } = await import("./shared-ollama.js");
    if (getOllamaUrl()) {
      const ollamaUp = await checkOllamaAvailable();
      if (ollamaUp) {
        const modelReady = await checkModelAvailable();
        if (modelReady) {
          log("  Ollama detected with nomic-embed-text ready.");
          const ans = (await ask(`Enable semantic search for fuzzy/paraphrase recovery? [y/N]: `)).trim().toLowerCase();
          ollamaEnabled = ans === "y" || ans === "yes";
        } else {
          log("  Ollama detected, but nomic-embed-text is not pulled yet.");
          const ans = (await ask(`Enable semantic search for fuzzy/paraphrase recovery? (will pull nomic-embed-text) [y/N]: `)).trim().toLowerCase();
          ollamaEnabled = ans === "y" || ans === "yes";
          if (ollamaEnabled) {
            log("  Run after init: ollama pull nomic-embed-text");
          }
        }
      } else {
        log("  Ollama not detected. Install it to enable semantic search:");
        log("    https://ollama.com  →  then: ollama pull nomic-embed-text");
        const ans = (await ask(`Enable semantic search (Ollama not installed yet)? [y/N]: `)).trim().toLowerCase();
        ollamaEnabled = ans === "y" || ans === "yes";
        if (ollamaEnabled) {
          log("  Semantic search enabled — will activate once Ollama is running.");
          log("  To disable: set CORTEX_OLLAMA_URL=off in your shell profile");
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] init ollamaCheck: ${errorMessage(err)}\n`);
  }

  log("\n─── Auto-capture (optional) ────────────────────────────────────────────");
  log("After each session, cortex scans the conversation for insight-signal phrases");
  log("(\"always\", \"never\", \"pitfall\", \"gotcha\", etc.) and saves them automatically.");
  log("  - Runs silently in the Stop hook; captured findings go to FINDINGS.md");
  log("  - You can review and remove any auto-captured entry at any time");
  log("  - Can be toggled: set CORTEX_FEATURE_AUTO_CAPTURE=0 to disable");
  const autoCaptureAnswer = (await ask(`Enable auto-capture? [Y/n]: `)).trim().toLowerCase();
  const autoCaptureEnabled = !(autoCaptureAnswer === "n" || autoCaptureAnswer === "no");

  // Only offer semantic dedup/conflict when an LLM endpoint is explicitly configured.
  // These features call /chat/completions, not an embedding endpoint, so we gate on
  // CORTEX_LLM_ENDPOINT (primary) or the presence of a known API key as a fallback.
  // CORTEX_EMBEDDING_API_URL alone is NOT sufficient — it only enables embeddings,
  // not the LLM chat call that callLlm() makes.
  const hasLlmApi = Boolean(
    process.env.CORTEX_LLM_ENDPOINT ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY
  );

  let semanticDedupEnabled = false;
  let semanticConflictEnabled = false;

  if (hasLlmApi) {
    log("\n─── LLM-powered memory quality (optional) ──────────────────────────────");
    log("Cortex can use an LLM to catch near-duplicate or conflicting findings.");
    log("  Requires: CORTEX_LLM_ENDPOINT or ANTHROPIC_API_KEY/OPENAI_API_KEY set");

    log("");
    log("Semantic dedup: before saving a finding, ask the LLM whether it means the");
    log("same thing as an existing one (catches same idea with different wording).");
    const dedupAnswer = (await ask(`Enable LLM-powered duplicate detection? [y/N]: `)).trim().toLowerCase();
    semanticDedupEnabled = dedupAnswer === "y" || dedupAnswer === "yes";

    log("");
    log("Conflict detection: after saving a finding, check whether it contradicts an");
    log("existing one (e.g. \"always use X\" vs \"never use X\"). Adds an inline annotation.");
    const conflictAnswer = (await ask(`Enable LLM-powered conflict detection? [y/N]: `)).trim().toLowerCase();
    semanticConflictEnabled = conflictAnswer === "y" || conflictAnswer === "yes";
  }

  log("\n─── GitHub sync ────────────────────────────────────────────────────────");
  log("Cortex stores memory as plain Markdown files in a git repo (~/.cortex).");
  log("Push it to a private GitHub repo to sync memory across machines.");
  log("  Hooks will auto-commit + push after every session and pull on start.");
  log("  Skip this if you just want to try cortex locally first.");
  const githubAnswer = (await ask(`GitHub username (or Enter to skip): `)).trim();
  const githubUsername = githubAnswer || undefined;
  let githubRepo: string | undefined;
  if (githubUsername) {
    const repoAnswer = (await ask(`Repo name [my-cortex]: `)).trim();
    githubRepo = repoAnswer || "my-cortex";
  }

  rl.close();

  log("");
  return { machine, profile, mcp, hooks, ollamaEnabled, autoCaptureEnabled, semanticDedupEnabled, semanticConflictEnabled, githubUsername, githubRepo };
}

export async function warmSemanticSearch(cortexPath: string, profile?: string): Promise<string> {
  const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl, getEmbeddingModel } = await import("./shared-ollama.js");
  const ollamaUrl = getOllamaUrl();
  if (!ollamaUrl) return "Semantic search: disabled.";

  const model = getEmbeddingModel();
  if (!await checkOllamaAvailable()) {
    return `Semantic search not warmed: Ollama offline at ${ollamaUrl}.`;
  }
  if (!await checkModelAvailable()) {
    return `Semantic search not warmed: model ${model} is not pulled yet.`;
  }

  const { buildIndex, listIndexedDocumentPaths } = await import("./shared-index.js");
  const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
  const { backgroundEmbedMissingDocs } = await import("./startup-embedding.js");
  const { getPersistentVectorIndex } = await import("./shared-vector-index.js");

  const db = await buildIndex(cortexPath, profile);
  try {
    const cache = getEmbeddingCache(cortexPath);
    await cache.load().catch(() => {});
    const allPaths = listIndexedDocumentPaths(cortexPath, profile);
    const before = cache.coverage(allPaths);
    if (before.missing > 0) {
      await backgroundEmbedMissingDocs(db, cache);
    }
    await cache.load().catch(() => {});
    const after = cache.coverage(allPaths);
    if (cache.size() > 0) {
      getPersistentVectorIndex(cortexPath).ensure(cache.getAllEntries());
    }
    if (after.total === 0) {
      return `Semantic search ready (${model}), but there are no indexed docs yet.`;
    }
    const embeddedNow = Math.max(0, after.embedded - before.embedded);
    const prefix = after.state === "warm" ? "Semantic search warmed" : "Semantic search warming";
    const delta = embeddedNow > 0 ? `; embedded ${embeddedNow} new docs during init` : "";
    return `${prefix}: ${model}, ${formatEmbeddingCoverage(after)}${delta}.`;
  } finally {
    try { db.close(); } catch { /* ignore close errors in init */ }
  }
}

export async function runInit(opts: InitOptions = {}) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const dryRun = Boolean(opts.dryRun);
  const existing = fs.existsSync(cortexPath);
  // Treat as existing install only when cortex-specific files are present.
  // An empty or non-cortex directory (e.g. from a partial clone) should not
  // trigger the update path.
  let hasExistingInstall = existing && (
    fs.existsSync(path.join(cortexPath, "machines.yaml")) ||
    fs.existsSync(path.join(cortexPath, ".governance")) ||
    fs.existsSync(path.join(cortexPath, "global"))
  );

  // Interactive walkthrough for first-time installs (skip with --yes or non-TTY)
  if (!hasExistingInstall && !dryRun && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const answers = await runWalkthrough();
    opts.machine = opts.machine || answers.machine;
    opts.profile = opts.profile || answers.profile;
    opts.mcp = opts.mcp || answers.mcp;
    opts.hooks = opts.hooks || answers.hooks;
    if (answers.cloneUrl) {
      opts._walkthroughCloneUrl = answers.cloneUrl;
    }
    if (answers.githubRepo) {
      opts._walkthroughGithub = { username: answers.githubUsername, repo: answers.githubRepo };
    }
    if (!answers.ollamaEnabled) {
      // User explicitly declined Ollama — note it but don't set env (they can set it themselves)
      process.env._CORTEX_WALKTHROUGH_OLLAMA_SKIP = "1";
    } else {
      opts._walkthroughSemanticSearch = true;
    }
    if (answers.autoCaptureEnabled) {
      // Write env var to ~/.cortex/.env so the Stop hook picks it up at runtime
      opts._walkthroughAutoCapture = true;
    }
    if (answers.semanticDedupEnabled) {
      opts._walkthroughSemanticDedup = true;
    }
    if (answers.semanticConflictEnabled) {
      opts._walkthroughSemanticConflict = true;
    }
  }

  // If the walkthrough provided a clone URL, clone it and treat as existing install
  if (opts._walkthroughCloneUrl) {
    log(`\nCloning existing cortex from ${opts._walkthroughCloneUrl}...`);
    try {
      execFileSync("git", ["clone", opts._walkthroughCloneUrl, cortexPath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      log(`  Cloned to ${cortexPath}`);
      // Re-check: the cloned repo should now be treated as an existing install
      hasExistingInstall = true;
    } catch (e: unknown) {
      log(`  Clone failed: ${e instanceof Error ? e.message : String(e)}`);
      log(`  Continuing with fresh install instead.`);
    }
  }

  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
  const hooksEnabled = opts.hooks ? opts.hooks === "on" : getHooksEnabledPreference(cortexPath);
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";
  const pendingBootstrap = getPendingBootstrapTarget(cortexPath, opts);

  if (dryRun) {
    log("\nInit dry run. No files will be written.\n");
    if (hasExistingInstall) {
      log(`cortex install detected at ${cortexPath}`);
      log(`Would update configuration for the existing install:\n`);
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);
      log(`  Reconfigure Claude Code MCP/hooks`);
      log(`  Reconfigure VS Code, Cursor, Copilot CLI, and Codex MCP targets`);
      if (hooksEnabled) {
        log(`  Reconfigure lifecycle hooks for detected tools`);
      }
      if (pendingBootstrap?.mode === "detected") {
        log(`  Would auto-bootstrap current project directory (${pendingBootstrap.path})`);
      }
      if (opts.applyStarterUpdate) {
        log(`  Apply starter template updates to global/CLAUDE.md and global skills`);
      }
      log(`  Run post-init verification checks`);
      log(`\nDry run complete.\n`);
      return;
    }

    log(`No existing cortex install found at ${cortexPath}`);
    log(`Would create a new cortex install:\n`);
    log(`  Copy starter files to ${cortexPath} (or create minimal structure)`);
    log(`  Update machines.yaml for machine "${opts.machine || getMachineName()}"`);
    log(`  Create/update config files`);
    log(`  MCP mode: ${mcpLabel}`);
    log(`  Hooks mode: ${hooksLabel}`);
    log(`  Configure Claude Code plus detected MCP targets (VS Code/Cursor/Copilot/Codex)`);
    if (hooksEnabled) {
      log(`  Configure lifecycle hooks for detected tools`);
    }
    if (pendingBootstrap?.mode === "detected") {
      log(`  Would auto-bootstrap current project directory (${pendingBootstrap.path})`);
    }
    log(`  Write install preferences and run post-init verification checks`);
    log(`\nDry run complete.\n`);
    return;
  }

  if (hasExistingInstall) {
      ensureGovernanceFiles(cortexPath);
      log(`\ncortex already exists at ${cortexPath}`);
      log(`Updating configuration...\n`);
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);

      // Confirmation prompt before writing config
      if (!opts.yes) {
        const settingsPath = hookConfigPath("claude");
        const modifications: string[] = [];
        modifications.push(`  ${settingsPath}  (update MCP server + hooks)`);
        log(`\nWill modify:`);
        for (const mod of modifications) log(mod);

        const confirmed = await confirmPrompt("\nProceed?");
        if (!confirmed) {
          log("Aborted.");
          return;
        }
      }

      // Always reconfigure MCP and hooks (picks up new features on upgrade)
      try {
        const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
        if (status === "disabled" || status === "already_disabled") {
          log(`  Updated Claude Code hooks (MCP disabled)`);
        } else {
          log(`  Updated Claude Code MCP + hooks`);
        }
      } catch (e) {
        log(`  Could not configure Claude Code settings (${e}), add manually`);
      }

      try {
        const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
        logMcpTargetStatus("VS Code", vscodeResult, "Updated");
      } catch (err: unknown) {
        debugLog(`configureVSCode failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
      }

      if (hooksEnabled) {
        try {
          const hooked = configureAllHooks(cortexPath);
          if (hooked.length) log(`  Updated hooks: ${hooked.join(", ")}`);
        } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
      } else {
        log(`  Hooks are disabled by preference (run: npx @alaarab/cortex hooks-mode on)`);
      }

      const prefs = readInstallPreferences(cortexPath);
      const previousVersion = prefs.installedVersion;
      if (isVersionNewer(VERSION, previousVersion)) {
        log(`\n  Starter template update available: v${previousVersion} -> v${VERSION}`);
        log(`  Run \`npx @alaarab/cortex init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
      }
      if (opts.applyStarterUpdate) {
        const updated = applyStarterTemplateUpdates(cortexPath);
        if (updated.length) {
          log(`  Applied starter template updates (${updated.length} file${updated.length === 1 ? "" : "s"}).`);
        } else {
          log(`  No starter template updates were applied (starter files not found).`);
        }
      }
      writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, installedVersion: VERSION });

      // Post-update verification
      log(`\nVerifying setup...`);
      const verify = runPostInitVerify(cortexPath);
      for (const check of verify.checks) {
        log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
      }

      // Auto-detect: if CWD looks like a project, bootstrap it automatically.
      const cwdProject = detectProjectDir(process.cwd(), cortexPath);
      if (cwdProject) {
        const projectName = normalizedBootstrapProjectName(cwdProject);
        if (!isProjectTracked(cortexPath, projectName)) {
          try {
            const created = bootstrapFromExisting(cortexPath, cwdProject, opts.profile);
            log(`\nDetected project in current directory — bootstrapped "${created}"`);
          } catch (e: unknown) {
            debugLog(`Auto-bootstrap from CWD failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      log(`\ncortex updated successfully`);
      log(`\nNext steps:`);
      log(`  1. Start a new Claude session in your project directory — cortex injects context automatically`);
      log(`  2. Run \`cortex doctor\` to verify everything is wired correctly`);
      log(`  3. After your first week, run /cortex-discover to surface gaps in your project knowledge`);
      log(`  4. After working across projects, run /cortex-consolidate to find cross-project patterns`);
      log(``);
      return;
  }

  log("\nSetting up cortex...\n");

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

  // Determine if CWD is a project that should be bootstrapped instead of
  // creating a dummy "my-first-project".
  const cwdProjectPath = !walkthroughProject ? detectProjectDir(process.cwd(), cortexPath) : null;
  const useTemplateProject = Boolean(walkthroughProject) || Boolean(opts.template);
  const firstProjectName = walkthroughProject || "my-first-project";

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
    // Rename the default project dir if the user chose a custom name via walkthrough
    if (walkthroughProject && walkthroughProject !== "my-first-project") {
      const defaultDir = path.join(cortexPath, "my-first-project");
      const customDir = path.join(cortexPath, walkthroughProject);
      if (fs.existsSync(defaultDir) && !fs.existsSync(customDir)) {
        fs.renameSync(defaultDir, customDir);
        // Update profile to reference the new project name
        updateStarterProfiles(cortexPath, (projects) => projects.map((project) => project === "my-first-project" ? walkthroughProject : project));
      }
    }
    // When no walkthrough project was specified and no template requested,
    // remove the dummy my-first-project that the starter ships with.
    // If CWD is a project, we'll bootstrap from it later; otherwise the user
    // starts with just global config and can `cortex add` projects explicitly.
    if (!useTemplateProject) {
      const defaultDir = path.join(cortexPath, "my-first-project");
      if (fs.existsSync(defaultDir)) {
        fs.rmSync(defaultDir, { recursive: true, force: true });
      }
      // Clean up profile yaml to not reference my-first-project
      updateStarterProfiles(cortexPath, (projects) => projects.filter((project) => project !== "my-first-project"));
    }
    if (opts.template) {
      const targetProject = walkthroughProject || firstProjectName;
      const projectDir = path.join(cortexPath, targetProject);
      if (applyTemplate(projectDir, opts.template, targetProject)) {
        log(`  Applied "${opts.template}" template to ${targetProject}`);
      } else {
        log(`  Template "${opts.template}" not found. Available: ${listTemplates().join(", ") || "none"}`);
      }
    }
    log(`  Created cortex v${VERSION} \u2192 ${cortexPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    atomicWriteText(
      path.join(cortexPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    if (useTemplateProject) {
      fs.mkdirSync(path.join(cortexPath, firstProjectName), { recursive: true });
      atomicWriteText(
        path.join(cortexPath, firstProjectName, "summary.md"),
        `# ${firstProjectName}\n\n**What:** Replace this with one sentence about what the project does\n**Stack:** The key tech\n**Status:** active\n**Run:** the command you use most\n**Watch out:** the one thing that will bite you if you forget\n`
      );
      atomicWriteText(
        path.join(cortexPath, firstProjectName, "CLAUDE.md"),
        `# ${firstProjectName}\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`
      );
      atomicWriteText(
        path.join(cortexPath, firstProjectName, "FINDINGS.md"),
        `# ${firstProjectName} FINDINGS\n\n<!-- Findings are captured automatically during sessions and committed on exit -->\n`
      );
      atomicWriteText(
        path.join(cortexPath, firstProjectName, "backlog.md"),
        `# ${firstProjectName} tasks\n\n## Active\n\n## Queue\n\n## Done\n`
      );
    }
    const profileName = opts.profile || "personal";
    const profileProjects = useTemplateProject
      ? `  - global\n  - ${firstProjectName}`
      : `  - global`;
    atomicWriteText(
      path.join(cortexPath, "profiles", `${profileName}.yaml`),
      `name: ${profileName}\ndescription: Default profile\nprojects:\n${profileProjects}\n`
    );
  }

  // If CWD is a project dir, bootstrap it now (replaces the old my-first-project flow)
  if (cwdProjectPath) {
    try {
      const created = bootstrapFromExisting(cortexPath, cwdProjectPath, opts.profile);
      log(`  Detected project in current directory — bootstrapped "${created}"`);
    } catch (e: unknown) {
      // Fresh-install auto-bootstrap is best-effort. If it fails, the install
      // still succeeded and the user can add the project explicitly later.
      debugLog(`Auto-bootstrap from CWD during fresh install failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Persist the local machine alias and map it to the selected profile.
  const effectiveMachine = opts.machine?.trim() || getMachineName();
  persistMachineName(effectiveMachine);
  updateMachinesYaml(cortexPath, effectiveMachine, opts.profile);
  ensureGovernanceFiles(cortexPath);
  log(`  Updated machines.yaml with machine "${effectiveMachine}"`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);

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

  // Configure Claude Code
  try {
    const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
    if (status === "disabled" || status === "already_disabled") {
      log(`  Configured Claude Code hooks (MCP disabled)`);
    } else {
      log(`  Configured Claude Code MCP + hooks`);
    }
  } catch (e) {
    log(`  Could not configure Claude Code settings (${e}), add manually`);
  }

  // Configure VS Code
  try {
    const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
    logMcpTargetStatus("VS Code", vscodeResult, "Configured");
  } catch (err: unknown) {
    debugLog(`configureVSCode failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
  }

  // Configure hooks for other detected AI coding tools (Copilot CLI, Cursor, Codex)
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(cortexPath);
      if (hooked.length) log(`  Configured hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log(`  Hooks are disabled by preference (run: npx @alaarab/cortex hooks-mode on)`);
  }

  writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, installedVersion: VERSION });

  // Post-init verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(cortexPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  log(`\nWhat was created:`);
  log(`  ${cortexPath}/global/CLAUDE.md    Global instructions loaded in every session`);
  log(`  ${cortexPath}/global/skills/      Cortex slash commands`);
  log(`  ${cortexPath}/profiles/           Machine-to-project mappings`);
  log(`  ${cortexPath}/.governance/        Memory quality settings and config`);

  // Ollama status summary (skip if already covered in walkthrough)
  const walkthroughCoveredOllama = Boolean(process.env._CORTEX_WALKTHROUGH_OLLAMA_SKIP) || (!hasExistingInstall && !opts.yes);
  if (!walkthroughCoveredOllama) {
    try {
      const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl } = await import("./shared-ollama.js");
      if (getOllamaUrl()) {
        const ollamaUp = await checkOllamaAvailable();
        if (ollamaUp) {
          const modelReady = await checkModelAvailable();
          if (modelReady) {
            log("\n  Semantic search: Ollama + nomic-embed-text ready.");
          } else {
            log("\n  Semantic search: Ollama running, but nomic-embed-text not pulled.");
            log("  Run: ollama pull nomic-embed-text");
          }
        } else {
          log("\n  Tip: Install Ollama for semantic search (optional).");
          log("  https://ollama.com → then: ollama pull nomic-embed-text");
          log("  (Set CORTEX_OLLAMA_URL=off to hide this message)");
        }
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] init ollamaInstallHint: ${errorMessage(err)}\n`);
    }
  }

  // Write ~/.cortex/.env if auto-capture or semantic features were enabled in walkthrough
  const envFile = path.join(cortexPath, ".env");
  const envFlags: { flag: string; label: string }[] = [];
  if (opts._walkthroughAutoCapture) envFlags.push({ flag: "CORTEX_FEATURE_AUTO_CAPTURE=1", label: "Auto-capture" });
  if (opts._walkthroughSemanticDedup) envFlags.push({ flag: "CORTEX_FEATURE_SEMANTIC_DEDUP=1", label: "Semantic dedup" });
  if (opts._walkthroughSemanticConflict) envFlags.push({ flag: "CORTEX_FEATURE_SEMANTIC_CONFLICT=1", label: "Conflict detection" });

  if (envFlags.length > 0) {
    let envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : `# cortex feature flags — generated by init\n`;
    let changed = false;
    for (const { flag } of envFlags) {
      const key = flag.split("=")[0];
      // Use exact line-prefix matching to avoid false positives from substring checks.
      // e.g. CORTEX_FEATURE_AUTO_CAPTURE=0 should not block writing CORTEX_FEATURE_AUTO_CAPTURE=1.
      const lines = envContent.split("\n");
      const hasKey = lines.some(l => l.trimStart().startsWith(key + "="));
      if (!hasKey) {
        envContent += `${flag}\n`;
        changed = true;
      }
    }
    if (changed) {
      const tmpPath = `${envFile}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, envContent);
      fs.renameSync(tmpPath, envFile);
    }
    for (const { label } of envFlags) {
      log(`  ${label}: enabled (${envFile})`);
    }
  }

  if (opts._walkthroughSemanticSearch) {
    log(`\nWarming semantic search...`);
    try {
      log(`  ${await warmSemanticSearch(cortexPath, opts.profile)}`);
    } catch (err: unknown) {
      log(`  Semantic search warmup failed: ${errorMessage(err)}`);
    }
  }

  log(`\ncortex initialized`);
  log(`\nNext steps:`);
  let step = 1;
  log(`  ${step++}. Start a new Claude session in your project directory — cortex injects context automatically`);
  log(`  ${step++}. Run \`cortex doctor\` to verify everything is wired correctly`);

  const gh = opts._walkthroughGithub;
  if (gh) {
    const remote = gh.username
      ? `git@github.com:${gh.username}/${gh.repo}.git`
      : `git@github.com:YOUR_USERNAME/${gh.repo}.git`;
    log(`  ${step++}. Push your cortex to GitHub (private repo recommended):`);
    log(`     cd ${cortexPath}`);
    log(`     git init && git add . && git commit -m "Initial cortex setup"`);
    if (gh.username) {
      log(`     gh repo create ${gh.username}/${gh.repo} --private --source=. --push`);
      log(`     # or manually: git remote add origin ${remote} && git push -u origin main`);
    } else {
      log(`     git remote add origin ${remote}`);
      log(`     git push -u origin main`);
    }
  } else {
    log(`  ${step++}. Push to GitHub for cross-machine sync (private repo recommended):`);
    log(`     cd ${cortexPath}`);
    log(`     git init && git add . && git commit -m "Initial cortex setup"`);
    log(`     git remote add origin git@github.com:YOUR_USERNAME/my-cortex.git`);
    log(`     git push -u origin main`);
  }

  log(`  ${step++}. Add more projects: cd ~/your-project && cortex add`);

  if (!mcpEnabled) {
    log(`  ${step++}. Turn MCP on: npx @alaarab/cortex mcp-mode on`);
  }
  log(`  ${step++}. After your first week, run /cortex-discover to surface gaps in your project knowledge`);
  log(`  ${step++}. After working across projects, run /cortex-consolidate to find cross-project patterns`);
  log(`\n  Read ${cortexPath}/README.md for a guided tour of each file.`);

  log(``);
}

export async function runMcpMode(modeArg?: string) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(cortexPath);
    const hooks = getHooksEnabledPreference(cortexPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx @alaarab/cortex mcp-mode on|off`);
    log(`Hooks toggle: npx @alaarab/cortex hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }
  const enabled = mode === "on";

  let claudeStatus: ToolStatus = "no_settings";
  let vscodeStatus: ToolStatus = "no_vscode";
  let cursorStatus: ToolStatus = "no_cursor";
  let copilotStatus: ToolStatus = "no_copilot";
  let codexStatus: ToolStatus = "no_codex";
  try { claudeStatus = configureClaude(cortexPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureClaude failed: ${errorMessage(err)}`); }
  try { vscodeStatus = configureVSCode(cortexPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureVSCode failed: ${errorMessage(err)}`); }
  try { cursorStatus = configureCursorMcp(cortexPath, { mcpEnabled: enabled }) ?? cursorStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCursorMcp failed: ${errorMessage(err)}`); }
  try { copilotStatus = configureCopilotMcp(cortexPath, { mcpEnabled: enabled }) ?? copilotStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCopilotMcp failed: ${errorMessage(err)}`); }
  try { codexStatus = configureCodexMcp(cortexPath, { mcpEnabled: enabled }) ?? codexStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCodexMcp failed: ${errorMessage(err)}`); }

  // Persist preference only after config writes have been attempted
  setMcpEnabledPreference(cortexPath, enabled);

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
  log(`Cursor status: ${cursorStatus}`);
  log(`Copilot CLI status: ${copilotStatus}`);
  log(`Codex status: ${codexStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runHooksMode(modeArg?: string) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(cortexPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx @alaarab/cortex hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }

  const enabled = mode === "on";

  let claudeStatus: ToolStatus = "no_settings";
  try {
    claudeStatus = configureClaude(cortexPath, {
      mcpEnabled: getMcpEnabledPreference(cortexPath),
      hooksEnabled: enabled,
    }) ?? claudeStatus;
  } catch (err: unknown) { debugLog(`hooks-mode: configureClaude failed: ${errorMessage(err)}`); }

  if (enabled) {
    try {
      const hooked = configureAllHooks(cortexPath);
      if (hooked.length) log(`Updated hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`hooks-mode: configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log("Hooks will no-op immediately via preference and Claude hooks are removed.");
  }

  // Persist preference only after config writes have been attempted
  setHooksEnabledPreference(cortexPath, enabled);

  log(`Hooks mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runUninstall() {
  log("\nUninstalling cortex...\n");

  const home = homeDir();
  const settingsPath = hookConfigPath("claude");

  // Remove from Claude Code ~/.claude.json (where MCP servers are actually read)
  const claudeJsonPath = homePath(".claude.json");
  if (fs.existsSync(claudeJsonPath)) {
    try {
      if (removeMcpServerAtPath(claudeJsonPath)) {
        log(`  Removed cortex MCP server from ~/.claude.json`);
      }
    } catch (e) {
      log(`  Warning: could not update ~/.claude.json (${e})`);
    }
  }

  // Remove from Claude Code settings.json
  if (fs.existsSync(settingsPath)) {
    try {
      patchJsonFile(settingsPath, (data) => {
        const hooksMap = isRecord(data.hooks) ? data.hooks as HookMap : (data.hooks = {} as HookMap);
        // Remove MCP server
        if (data.mcpServers?.cortex) {
          delete data.mcpServers.cortex;
          log(`  Removed cortex MCP server from Claude Code settings`);
        }

        // Remove hooks containing cortex references
        for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const) {
          const hooks = hooksMap[hookEvent] as HookEntry[] | undefined;
          if (!Array.isArray(hooks)) continue;
          const before = hooks.length;
          hooksMap[hookEvent] = hooks.filter(
            (h: HookEntry) => !h.hooks?.some(
              (hook) => typeof hook.command === "string" && isCortexCommand(hook.command)
            )
          );
          const removed = before - (hooksMap[hookEvent] as HookEntry[]).length;
          if (removed > 0) log(`  Removed ${removed} cortex hook(s) from ${hookEvent}`);
        }
      });
    } catch (e) {
      log(`  Warning: could not update Claude Code settings (${e})`);
    }
  } else {
    log(`  Claude Code settings not found at ${settingsPath} — skipping`);
  }

  // Remove from VS Code mcp.json
  const vsCandidates = vscodeMcpCandidates().map((dir) => path.join(dir, "mcp.json"));
  for (const mcpFile of vsCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from VS Code MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Cursor MCP config
  const cursorCandidates = cursorMcpCandidates();
  for (const mcpFile of cursorCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Cursor MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Copilot CLI MCP config
  const copilotCandidates = copilotMcpCandidates();
  for (const mcpFile of copilotCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Copilot CLI MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Codex MCP config (TOML + JSON)
  const codexToml = path.join(home, ".codex", "config.toml");
  try {
    if (removeTomlMcpServer(codexToml)) {
      log(`  Removed cortex from Codex MCP config (${codexToml})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexToml}: ${errorMessage(err)}`); }

  const codexCandidates = codexJsonCandidates(process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH);
  for (const mcpFile of codexCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Codex MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove Copilot hooks file (written by configureAllHooks)
  const copilotHooksFile = hookConfigPath("copilot", process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH);
  try {
    if (fs.existsSync(copilotHooksFile)) {
      fs.unlinkSync(copilotHooksFile);
      log(`  Removed Copilot hooks file (${copilotHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${copilotHooksFile}: ${errorMessage(err)}`); }

  // Remove cortex entries from Cursor hooks file (may contain non-cortex entries)
  const cursorHooksFile = hookConfigPath("cursor", process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH);
  try {
    if (fs.existsSync(cursorHooksFile)) {
      const raw = JSON.parse(fs.readFileSync(cursorHooksFile, "utf8"));
      let changed = false;
      for (const key of ["sessionStart", "beforeSubmitPrompt", "stop"]) {
        if (raw[key]?.command && typeof raw[key].command === "string" && isCortexCommand(raw[key].command)) {
          delete raw[key];
          changed = true;
        }
      }
      if (changed) {
        atomicWriteText(cursorHooksFile, JSON.stringify(raw, null, 2));
        log(`  Removed cortex entries from Cursor hooks (${cursorHooksFile})`);
      }
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${cursorHooksFile}: ${errorMessage(err)}`); }

  // Remove Codex hooks file in cortex path
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const codexHooksFile = hookConfigPath("codex", cortexPath);
  try {
    if (fs.existsSync(codexHooksFile)) {
      fs.unlinkSync(codexHooksFile);
      log(`  Removed Codex hooks file (${codexHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexHooksFile}: ${errorMessage(err)}`); }

  // Remove session wrapper scripts (written by installSessionWrapper)
  const localBinDir = path.join(home, ".local", "bin");
  for (const tool of ["copilot", "cursor", "codex"]) {
    const wrapperPath = path.join(localBinDir, tool);
    try {
      if (fs.existsSync(wrapperPath)) {
        // Only remove if it's a cortex wrapper (check for CORTEX_PATH marker)
        const content = fs.readFileSync(wrapperPath, "utf8");
        if (content.includes("CORTEX_PATH") && content.includes("cortex")) {
          fs.unlinkSync(wrapperPath);
          log(`  Removed ${tool} session wrapper (${wrapperPath})`);
        }
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${wrapperPath}: ${errorMessage(err)}`); }
  }

  log(`\nCortex hooks and MCP config removed.`);
  log(`\nYour Cortex data at ~/.cortex was NOT deleted.`);
  log(`To fully remove it, run: rm -rf ~/.cortex\n`);
  log(`Restart your agent(s) to apply changes.\n`);
}
