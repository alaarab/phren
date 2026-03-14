import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  debugLog,
  EXEC_TIMEOUT_QUICK_MS,
  getProjectDirs,
  isRecord,
  homeDir,
  homePath,
  hookConfigPath,
  runtimeHealthFile,
} from "./shared.js";
import { validateGovernanceJson } from "./shared-governance.js";
import { errorMessage } from "./utils.js";
import { buildIndex, queryRows } from "./shared-index.js";
import { validateTaskFormat, validateFindingsFormat } from "./shared-content.js";
import { detectInstalledTools } from "./hooks.js";
import { validateSkillFrontmatter, validateSkillsDir } from "./link-skills.js";
import { verifyFileChecksums, updateFileChecksums } from "./link-checksums.js";
import { buildSkillManifest } from "./skill-registry.js";
import { inspectTaskHygiene } from "./task-hygiene.js";
import { resolveTaskFilePath, TASK_FILE_ALIASES } from "./data-tasks.js";
import { repairPreexistingInstall } from "./init-setup.js";
import {
  getMachineName,
  lookupProfile,
  findProfileFile,
  getProfileProjects,
  findProjectDir,
} from "./link.js";
import { claudeProjectKey } from "./link-context.js";
import type { DoctorResult } from "./link.js";
import { getProjectOwnershipMode, readProjectConfig } from "./project-config.js";

// ── Doctor ──────────────────────────────────────────────────────────────────

function isWrapperActive(tool: string): boolean {
  const wrapperPath = homePath(".local", "bin", tool);
  if (!fs.existsSync(wrapperPath)) return false;
  try {
    const resolved = execFileSync("which", [tool], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    return path.resolve(resolved) === path.resolve(wrapperPath);
  } catch (err: unknown) {
    debugLog(`isWrapperActive: which ${tool} failed: ${errorMessage(err)}`);
    return false;
  }
}

function commandVersion(cmd: string, args: string[] = ["--version"]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
  } catch (err: unknown) {
    debugLog(`doctor: commandVersion ${cmd} failed: ${errorMessage(err)}`);
    return null;
  }
}

function parseSemverTriple(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

function versionAtLeast(raw: string | null, major: number, minor: number = 0): boolean {
  if (!raw) return false;
  const parsed = parseSemverTriple(raw);
  if (!parsed) return false;
  const [m, n] = parsed;
  if (m !== major) return m > major;
  return n >= minor;
}

function nearestWritableTarget(filePath: string): boolean {
  let probe = fs.existsSync(filePath) ? filePath : path.dirname(filePath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch (err: unknown) {
    debugLog(`doctor: writable check failed for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

function gitRemoteStatus(phrenPath: string): { ok: boolean; detail: string } {
  try {
    execFileSync("git", ["-C", phrenPath, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
  } catch {
    return { ok: false, detail: "phren path is not a git repository" };
  }
  try {
    const remote = execFileSync("git", ["-C", phrenPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    return remote
      ? { ok: true, detail: `origin=${remote}` }
      : { ok: true, detail: "no remote configured (local-only sync mode)" };
  } catch {
    return { ok: true, detail: "no remote configured (local-only sync mode)" };
  }
}

function pushSkillMirrorChecks(
  checks: Array<{ name: string; ok: boolean; detail: string }>,
  scope: string,
  manifest: ReturnType<typeof buildSkillManifest>,
  destDir: string,
): void {
  const parentDir = path.dirname(destDir);
  checks.push({
    name: `skills-manifest:${scope}`,
    ok: fs.existsSync(path.join(parentDir, "skill-manifest.json")),
    detail: fs.existsSync(path.join(parentDir, "skill-manifest.json"))
      ? `generated: ${path.join(parentDir, "skill-manifest.json")}`
      : `missing generated manifest at ${path.join(parentDir, "skill-manifest.json")}`,
  });
  checks.push({
    name: `skills-commands:${scope}`,
    ok: fs.existsSync(path.join(parentDir, "skill-commands.json")),
    detail: fs.existsSync(path.join(parentDir, "skill-commands.json"))
      ? `generated: ${path.join(parentDir, "skill-commands.json")}`
      : `missing generated command registry at ${path.join(parentDir, "skill-commands.json")}`,
  });

  for (const skill of manifest.skills.filter((entry) => entry.visibleToAgents)) {
    const dest = path.join(destDir, skill.format === "folder" ? skill.name : path.basename(skill.path));
    let ok = false;
    try {
      ok = fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(skill.root);
    } catch (err: unknown) {
      debugLog(`doctor: skill mirror check failed for ${dest}: ${errorMessage(err)}`);
      ok = false;
    }
    checks.push({
      name: `skills-mirror:${scope}/${skill.name}`,
      ok,
      detail: ok ? "ok" : `missing/drifted link at ${dest}`,
    });
  }

  for (const problem of manifest.problems) {
    checks.push({
      name: `skills-problem:${scope}:${problem.code}`,
      ok: false,
      detail: problem.message,
    });
  }
}

export async function runDoctor(phrenPath: string, fix: boolean = false, checkData: boolean = false): Promise<DoctorResult> {
  // Import runLink lazily to avoid circular dependency at module load time
  const { runLink } = await import("./link.js");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const machine = getMachineName();
  const profile = lookupProfile(phrenPath, machine);
  const gitVersion = commandVersion("git");
  const nodeVersion = commandVersion("node");
  checks.push({
    name: "git-installed",
    ok: Boolean(gitVersion),
    detail: gitVersion || "git not found in PATH",
  });
  checks.push({
    name: "node-version",
    ok: versionAtLeast(nodeVersion, 20),
    detail: nodeVersion || "node not found in PATH",
  });
  const gitRemote = gitRemoteStatus(phrenPath);
  checks.push({
    name: "git-remote",
    ok: gitRemote.ok,
    detail: gitRemote.detail,
  });

  checks.push({
    name: "machine-registered",
    ok: Boolean(profile),
    detail: profile
      ? `machine=${machine} profile=${profile}`
      : `no profile mapping for machine=${machine} in machines.yaml`,
  });

  const profileFile = profile ? findProfileFile(phrenPath, profile) : null;
  checks.push({
    name: "profile-exists",
    ok: Boolean(profileFile),
    detail: profileFile ? `profile file found: ${profileFile}` : "profile file missing",
  });

  const projects = profileFile ? getProfileProjects(profileFile) : [];
  checks.push({
    name: "profile-projects",
    ok: projects.length > 0,
    detail: projects.length ? `${projects.length} projects in profile` : "no projects listed",
  });

  // Filesystem speed check
  const fsBenchFile = path.join(phrenPath, ".fs-bench-tmp");
  let fsMs = 0;
  try {
    const t0 = Date.now();
    fs.writeFileSync(fsBenchFile, "phren-fs-check");
    fs.readFileSync(fsBenchFile, "utf8");
    fs.unlinkSync(fsBenchFile);
    fsMs = Date.now() - t0;
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] doctor fsBenchmark: ${errorMessage(err)}\n`);
    fsMs = -1;
    try { fs.unlinkSync(fsBenchFile); } catch (e2: unknown) {
      if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] doctor fsBenchmarkCleanup: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
    }
  }
  const fsSlow = fsMs > 500 || fsMs < 0;
  checks.push({
    name: "filesystem-speed",
    ok: !fsSlow,
    detail: fsMs < 0
      ? "could not benchmark filesystem, check ~/.phren permissions"
      : `write+read+delete in ${fsMs}ms${fsSlow ? " (slow, check if ~/.phren is on a network mount)" : ""}`,
  });

  const contextFile = homePath(".phren-context.md");
  checks.push({
    name: "context-file",
    ok: fs.existsSync(contextFile),
    detail: fs.existsSync(contextFile) ? contextFile : "missing ~/.phren-context.md",
  });

  const memoryFile = path.join(
    homeDir(),
    ".claude",
    "projects",
    claudeProjectKey(),
    "memory",
    "MEMORY.md"
  );
  checks.push({
    name: "root-memory",
    ok: fs.existsSync(memoryFile),
    detail: fs.existsSync(memoryFile) ? memoryFile : "missing generated MEMORY.md",
  });

  const globalClaudeSrc = path.join(phrenPath, "global", "CLAUDE.md");
  const globalClaudeDest = homePath(".claude", "CLAUDE.md");
  let globalLinkOk = false;
  try {
    globalLinkOk = fs.existsSync(globalClaudeDest) && fs.realpathSync(globalClaudeDest) === fs.realpathSync(globalClaudeSrc);
  } catch (err: unknown) {
    debugLog(`doctor: global CLAUDE.md symlink check failed: ${errorMessage(err)}`);
    globalLinkOk = false;
  }
  checks.push({
    name: "global-link",
    ok: globalLinkOk,
    detail: globalLinkOk ? "global CLAUDE.md symlink ok" : "global CLAUDE.md link drifted/missing",
  });
  pushSkillMirrorChecks(
    checks,
    "global",
    buildSkillManifest(phrenPath, profile || "", "global", homePath(".claude", "skills")),
    homePath(".claude", "skills"),
  );

  for (const project of projects) {
    if (project === "global") continue;
    const config = readProjectConfig(phrenPath, project);
    const ownership = getProjectOwnershipMode(phrenPath, project, config);
    const target = findProjectDir(project);
    if (ownership !== "phren-managed") {
      checks.push({
        name: `ownership:${project}`,
        ok: true,
        detail: `repo mirrors disabled (${ownership})`,
      });
      continue;
    }
    if (!target) {
      checks.push({ name: `project-path:${project}`, ok: false, detail: "project directory not found on disk" });
      continue;
    }
    for (const f of ["CLAUDE.md", "REFERENCE.md", "FINDINGS.md"]) {
      const src = path.join(phrenPath, project, f);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(target, f);
      let ok = false;
      try {
        ok = fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(src);
      } catch (err: unknown) {
        debugLog(`doctor: symlink check failed for ${dest}: ${errorMessage(err)}`);
        ok = false;
      }
      checks.push({
        name: `symlink:${project}/${f}`,
        ok,
        detail: ok ? "ok" : `missing/drifted link at ${dest}`,
      });
    }
    pushSkillMirrorChecks(
      checks,
      project,
      buildSkillManifest(phrenPath, profile || "", project, path.join(target, ".claude", "skills")),
      path.join(target, ".claude", "skills"),
    );
  }

  const settingsPath = hookConfigPath("claude");
  const configWritable = nearestWritableTarget(settingsPath);
  checks.push({
    name: "config-writable",
    ok: configWritable,
    detail: configWritable ? `writable: ${settingsPath}` : `not writable: ${settingsPath}`,
  });
  let hookOk = false;
  let lifecycleOk = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const hooks = cfg?.hooks || {};
    const promptHooks = JSON.stringify(hooks.UserPromptSubmit || []);
    const stopHooks = JSON.stringify(hooks.Stop || []);
    const startHooks = JSON.stringify(hooks.SessionStart || []);
    hookOk = promptHooks.includes("hook-prompt");
    const stopHookOk = stopHooks.includes("hook-stop");
    const startHookOk = startHooks.includes("hook-session-start");
    lifecycleOk = stopHookOk && startHookOk;
  } catch (err: unknown) {
    debugLog(`doctor: failed to read Claude settings for hook check: ${errorMessage(err)}`);
    hookOk = false;
    lifecycleOk = false;
  }
  checks.push({
    name: "claude-hooks",
    ok: hookOk,
    detail: hookOk ? "prompt hook configured" : "missing prompt hook in settings.json",
  });
  checks.push({
    name: "lifecycle-hooks",
    ok: lifecycleOk,
    detail: lifecycleOk
      ? "session-start + stop lifecycle hooks configured"
      : "missing lifecycle hooks (expected hook-session-start and hook-stop)",
  });

  const runtimeHealthPath = runtimeHealthFile(phrenPath);
  let runtime: Record<string, unknown> | null = null;
  if (fs.existsSync(runtimeHealthPath)) {
    try { runtime = JSON.parse(fs.readFileSync(runtimeHealthPath, "utf8")); } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] doctor runtimeHealth: ${errorMessage(err)}\n`);
      runtime = null;
    }
  }
  checks.push({
    name: "runtime-health-file",
    ok: Boolean(runtime),
    detail: runtime ? runtimeHealthPath : "missing or unreadable .runtime/runtime-health.json",
  });
  const lastAutoSave = runtime?.["lastAutoSave"];
  const autoSaveObj = isRecord(lastAutoSave) ? lastAutoSave : null;
  const autoSaveStatus = typeof autoSaveObj?.["status"] === "string" ? autoSaveObj["status"] : undefined;
  const autoSaveAt = typeof autoSaveObj?.["at"] === "string" ? autoSaveObj["at"] : undefined;
  checks.push({
    name: "runtime-auto-save",
    ok: autoSaveStatus === "saved-pushed" || autoSaveStatus === "saved-local" || autoSaveStatus === "clean",
    detail: autoSaveStatus
      ? `last auto-save: ${autoSaveStatus}${autoSaveAt ? ` @ ${autoSaveAt}` : ""}`
      : "no auto-save runtime record yet",
  });
  checks.push({
    name: "runtime-prompt",
    ok: Boolean(runtime?.["lastPromptAt"]),
    detail: runtime?.["lastPromptAt"] ? `last prompt hook run @ ${runtime["lastPromptAt"]}` : "no prompt runtime record yet",
  });

  try {
    const db = await buildIndex(phrenPath, profile || undefined);
    const healthRow = queryRows(db, "SELECT count(*) FROM docs", []);
    const count = Number((healthRow?.[0]?.[0] as number | string | undefined) ?? 0);
    checks.push({
      name: "fts-index",
      ok: Number.isFinite(count) && count >= 0,
      detail: `index query ok (docs=${count})`,
    });
  } catch (err: unknown) {
    checks.push({
      name: "fts-index",
      ok: false,
      detail: `index build/query failed: ${errorMessage(err)}`,
    });
  }

  const detected = detectInstalledTools();
  if (detected.has("copilot")) {
    const copilotHooks = hookConfigPath("copilot", phrenPath);
    checks.push({
      name: "copilot-hooks",
      ok: fs.existsSync(copilotHooks),
      detail: fs.existsSync(copilotHooks) ? "copilot hooks config present" : "missing copilot hooks config",
    });
    checks.push({
      name: "copilot-config-writable",
      ok: nearestWritableTarget(copilotHooks),
      detail: nearestWritableTarget(copilotHooks) ? `writable: ${copilotHooks}` : `not writable: ${copilotHooks}`,
    });
  }
  if (detected.has("cursor")) {
    const cursorHooks = hookConfigPath("cursor", phrenPath);
    checks.push({
      name: "cursor-hooks",
      ok: fs.existsSync(cursorHooks),
      detail: fs.existsSync(cursorHooks) ? "cursor hooks config present" : "missing ~/.cursor/hooks.json",
    });
    checks.push({
      name: "cursor-config-writable",
      ok: nearestWritableTarget(cursorHooks),
      detail: nearestWritableTarget(cursorHooks) ? `writable: ${cursorHooks}` : `not writable: ${cursorHooks}`,
    });
  }
  if (detected.has("codex")) {
    const codexHooks = hookConfigPath("codex", phrenPath);
    checks.push({
      name: "codex-hooks",
      ok: fs.existsSync(codexHooks),
      detail: fs.existsSync(codexHooks) ? "codex hooks config present" : "missing codex hooks config in phren root",
    });
    checks.push({
      name: "codex-config-writable",
      ok: nearestWritableTarget(codexHooks),
      detail: nearestWritableTarget(codexHooks) ? `writable: ${codexHooks}` : `not writable: ${codexHooks}`,
    });
  }
  for (const tool of ["copilot", "cursor", "codex"]) {
    if (!detected.has(tool)) continue;
    const active = isWrapperActive(tool);
    checks.push({
      name: `wrapper:${tool}`,
      ok: active,
      detail: active
        ? `${tool} wrapper active via ~/.local/bin/${tool}`
        : `${tool} wrapper missing or not first in PATH`,
    });
  }

  if (fix) {
    const repaired = repairPreexistingInstall(phrenPath);
    const details: string[] = [];
    if (repaired.removedLegacyProjects > 0) details.push(`removed ${repaired.removedLegacyProjects} legacy sample profile entries`);
    if (repaired.createdContextFile) details.push("recreated ~/.phren-context.md");
    if (repaired.createdRootMemory) details.push("recreated generated MEMORY.md");
    if (details.length === 0) details.push("baseline repair complete");
    checks.push({ name: "baseline-repair", ok: true, detail: details.join("; ") });
  }

  if (fix && profile && profileFile) {
    await runLink(phrenPath, { machine, profile });
    checks.push({ name: "self-heal", ok: true, detail: "relinked hooks, symlinks, context, memory pointers" });
  } else if (fix) {
    checks.push({ name: "self-heal", ok: false, detail: "relink blocked: machine/profile not fully configured" });
  } else {
    // Read-only mode: just check if hook configs exist, don't write anything
    const detectedTools = detectInstalledTools();
    const hookChecks: string[] = [];
    const missing: string[] = [];
    for (const tool of detectedTools) {
      let configPath = "";
      if (tool === "copilot" || tool === "cursor" || tool === "codex") {
        configPath = hookConfigPath(tool, phrenPath);
      }
      if (configPath && fs.existsSync(configPath)) hookChecks.push(tool);
      else if (configPath) missing.push(tool);
    }
    checks.push({
      name: "hooks",
      ok: missing.length === 0,
      detail: hookChecks.length
        ? `hook configs present for: ${hookChecks.join(", ")}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`
        : detectedTools.size === 0
          ? "no external tools detected"
          : `missing hook configs for: ${missing.join(", ")}`,
    });
  }

  if (checkData) {
    const governanceChecks: Array<{ file: string; schema: "retention-policy" | "workflow-policy" | "index-policy" }> = [
      { file: "retention-policy.json", schema: "retention-policy" },
      { file: "workflow-policy.json", schema: "workflow-policy" },
      { file: "index-policy.json", schema: "index-policy" },
    ];

    for (const item of governanceChecks) {
      const filePath = path.join(phrenPath, ".governance", item.file);
      const exists = fs.existsSync(filePath);
      const valid = exists ? validateGovernanceJson(filePath, item.schema) : false;
      checks.push({
        name: `data:governance:${item.file}`,
        ok: exists && valid,
        detail: !exists ? "missing governance file" : valid ? "valid" : "invalid JSON/schema",
      });
    }

    const runtimeChecks = [
      { filePath: runtimeHealthFile(phrenPath), name: "data:runtime:runtime-health.json" },
    ];
    for (const item of runtimeChecks) {
      const exists = fs.existsSync(item.filePath);
      checks.push({
        name: item.name,
        ok: exists,
        detail: exists ? "present" : "missing runtime file",
      });
    }

    for (const projectDir of getProjectDirs(phrenPath, profile)) {
      const projectName = path.basename(projectDir);
      if (projectName === "global") continue;

      const taskPath = resolveTaskFilePath(phrenPath, projectName);
      if (taskPath && fs.existsSync(taskPath)) {
        const content = fs.readFileSync(taskPath, "utf8");
        const issues = validateTaskFormat(content);
        checks.push({
          name: `data:tasks:${projectName}`,
          ok: issues.length === 0,
          detail: issues.length ? issues.join("; ") : "valid task file",
        });

        const repoPath = findProjectDir(projectName);
        const hygiene = inspectTaskHygiene(phrenPath, projectName, repoPath);
        checks.push({
          name: `data:task-hygiene:${projectName}`,
          ok: hygiene.ok,
          detail: hygiene.detail,
        });
      }

      const findingsPath = path.join(projectDir, "FINDINGS.md");
      if (fs.existsSync(findingsPath)) {
        const content = fs.readFileSync(findingsPath, "utf8");
        const issues = validateFindingsFormat(content);
        checks.push({
          name: `data:findings:${projectName}`,
          ok: issues.length === 0,
          detail: issues.length ? issues.join("; ") : "valid",
        });
      }
    }

    // Detect conflict markers in project markdown files
    for (const projectDir of getProjectDirs(phrenPath, profile)) {
      const projectName = path.basename(projectDir);
      if (projectName === "global") continue;

      for (const mdFile of ["FINDINGS.md", ...TASK_FILE_ALIASES, "review.md", "CLAUDE.md", "REFERENCE.md"]) {
        const filePath = path.join(projectDir, mdFile);
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf8");
        const hasConflict = /^<{7} |^={7}$|^>{7} /m.test(content);
        if (hasConflict) {
          checks.push({
            name: `data:conflict-markers:${projectName}/${mdFile}`,
            ok: false,
            detail: `${projectName}/${mdFile} contains git conflict markers`,
          });
        }
      }
    }

    // Validate skill frontmatter in global/skills under phren data dir
    const globalSkillsDir = path.join(phrenPath, "global", "skills");
    const skillResults = validateSkillsDir(fs.existsSync(globalSkillsDir) ? globalSkillsDir : path.join(phrenPath, "global"));
    const invalidSkills = skillResults.filter(r => !r.valid);
    checks.push({
      name: "data:skills-frontmatter",
      ok: invalidSkills.length === 0,
      detail: invalidSkills.length
        ? `${invalidSkills.length} skill(s) with invalid frontmatter: ${invalidSkills.flatMap(r => r.errors).join("; ")}`
        : `${skillResults.length} skill(s) validated`,
    });

    // Validate phren.SKILL.md manifest
    const manifestPath = path.join(phrenPath, "phren.SKILL.md");
    if (fs.existsSync(manifestPath)) {
      const manifestResult = validateSkillFrontmatter(fs.readFileSync(manifestPath, "utf8"), manifestPath);
      checks.push({
        name: "data:skill-manifest",
        ok: manifestResult.valid,
        detail: manifestResult.valid ? "phren.SKILL.md frontmatter valid" : manifestResult.errors.join("; "),
      });
    }

    // Verify file checksums
    const checksumResults = verifyFileChecksums(phrenPath);
    const mismatches = checksumResults.filter((r) => r.status === "mismatch");
    const missingFiles = checksumResults.filter((r) => r.status === "missing");
    if (checksumResults.length > 0) {
      checks.push({
        name: "data:file-checksums",
        ok: mismatches.length === 0 && missingFiles.length === 0,
        detail: mismatches.length || missingFiles.length
          ? `${mismatches.length} mismatch(es), ${missingFiles.length} missing`
          : `${checksumResults.length} file(s) verified`,
      });
    }

    if (fix) {
      updateFileChecksums(phrenPath, profile);
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, machine, profile: profile || undefined, checks };
}
