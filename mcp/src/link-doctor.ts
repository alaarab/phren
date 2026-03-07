import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import {
  debugLog,
  EXEC_TIMEOUT_QUICK_MS,
  getProjectDirs,
  isRecord,
} from "./shared.js";
import { validateGovernanceJson } from "./shared-governance.js";
import { buildIndex, queryRows } from "./shared-index.js";
import { validateBacklogFormat, validateFindingsFormat } from "./shared-content.js";
import { detectInstalledTools } from "./hooks.js";
import { validateSkillFrontmatter, validateSkillsDir } from "./link-skills.js";
import { verifyFileChecksums, updateFileChecksums } from "./link-checksums.js";
import {
  getMachineName,
  lookupProfile,
  findProfileFile,
  getProfileProjects,
  findProjectDir,
  safeUsername,
} from "./link.js";
import type { DoctorResult } from "./link.js";

// ── Doctor ──────────────────────────────────────────────────────────────────

export function isWrapperActive(tool: string): boolean {
  const wrapperPath = path.join(os.homedir(), ".local", "bin", tool);
  if (!fs.existsSync(wrapperPath)) return false;
  try {
    const resolved = execFileSync("which", [tool], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    return path.resolve(resolved) === path.resolve(wrapperPath);
  } catch (err: unknown) {
    debugLog(`isWrapperActive: which ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function runDoctor(cortexPath: string, fix: boolean = false, checkData: boolean = false): Promise<DoctorResult> {
  // Import runLink lazily to avoid circular dependency at module load time
  const { runLink } = await import("./link.js");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const machine = getMachineName();
  const profile = lookupProfile(cortexPath, machine);

  checks.push({
    name: "machine-registered",
    ok: Boolean(profile),
    detail: profile
      ? `machine=${machine} profile=${profile}`
      : `no profile mapping for machine=${machine} in machines.yaml`,
  });

  const profileFile = profile ? findProfileFile(cortexPath, profile) : null;
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
  const fsBenchFile = path.join(cortexPath, ".fs-bench-tmp");
  let fsMs = 0;
  try {
    const t0 = Date.now();
    fs.writeFileSync(fsBenchFile, "cortex-fs-check");
    fs.readFileSync(fsBenchFile, "utf8");
    fs.unlinkSync(fsBenchFile);
    fsMs = Date.now() - t0;
  } catch {
    fsMs = -1;
    try { fs.unlinkSync(fsBenchFile); } catch { /* ignore */ }
  }
  const fsSlow = fsMs > 500 || fsMs < 0;
  checks.push({
    name: "filesystem-speed",
    ok: !fsSlow,
    detail: fsMs < 0
      ? "could not benchmark filesystem, check ~/.cortex permissions"
      : `write+read+delete in ${fsMs}ms${fsSlow ? " (slow, check if ~/.cortex is on a network mount)" : ""}`,
  });

  const contextFile = path.join(os.homedir(), ".cortex-context.md");
  checks.push({
    name: "context-file",
    ok: fs.existsSync(contextFile),
    detail: fs.existsSync(contextFile) ? contextFile : "missing ~/.cortex-context.md",
  });

  const memoryFile = path.join(
    os.homedir(),
    ".claude",
    "projects",
    `-home-${safeUsername()}`,
    "memory",
    "MEMORY.md"
  );
  checks.push({
    name: "root-memory",
    ok: fs.existsSync(memoryFile),
    detail: fs.existsSync(memoryFile) ? memoryFile : "missing generated MEMORY.md",
  });

  const globalClaudeSrc = path.join(cortexPath, "global", "CLAUDE.md");
  const globalClaudeDest = path.join(os.homedir(), ".claude", "CLAUDE.md");
  let globalLinkOk = false;
  try {
    globalLinkOk = fs.existsSync(globalClaudeDest) && fs.realpathSync(globalClaudeDest) === fs.realpathSync(globalClaudeSrc);
  } catch (err: unknown) {
    debugLog(`doctor: global CLAUDE.md symlink check failed: ${err instanceof Error ? err.message : String(err)}`);
    globalLinkOk = false;
  }
  checks.push({
    name: "global-link",
    ok: globalLinkOk,
    detail: globalLinkOk ? "global CLAUDE.md symlink ok" : "global CLAUDE.md link drifted/missing",
  });

  for (const project of projects) {
    if (project === "global") continue;
    const target = findProjectDir(project);
    if (!target) {
      checks.push({ name: `project-path:${project}`, ok: false, detail: "project directory not found on disk" });
      continue;
    }
    for (const f of ["CLAUDE.md", "REFERENCE.md", "FINDINGS.md"]) {
      const src = path.join(cortexPath, project, f);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(target, f);
      let ok = false;
      try {
        ok = fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(src);
      } catch (err: unknown) {
        debugLog(`doctor: symlink check failed for ${dest}: ${err instanceof Error ? err.message : String(err)}`);
        ok = false;
      }
      checks.push({
        name: `symlink:${project}/${f}`,
        ok,
        detail: ok ? "ok" : `missing/drifted link at ${dest}`,
      });
    }
  }

  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let hookOk = false;
  let lifecycleOk = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const hooks = cfg?.hooks || {};
    const promptHooks = JSON.stringify(hooks.UserPromptSubmit || []);
    const stopHooks = JSON.stringify(hooks.Stop || []);
    const startHooks = JSON.stringify(hooks.SessionStart || []);
    hookOk = promptHooks.includes("hook-prompt");
    const stopHookOk = stopHooks.includes("hook-stop") || stopHooks.includes("auto-save");
    const startHookOk = startHooks.includes("hook-session-start") || startHooks.includes("doctor --fix");
    lifecycleOk = stopHookOk && startHookOk;
  } catch (err: unknown) {
    debugLog(`doctor: failed to read Claude settings for hook check: ${err instanceof Error ? err.message : String(err)}`);
    hookOk = false;
    lifecycleOk = false;
  }
  checks.push({
    name: "claude-hooks",
    ok: hookOk,
    detail: hookOk ? "prompt hook configured" : "missing prompt hook in ~/.claude/settings.json",
  });
  checks.push({
    name: "lifecycle-hooks",
    ok: lifecycleOk,
    detail: lifecycleOk
      ? "session-start + stop lifecycle hooks configured"
      : "missing lifecycle hooks (expected hook-session-start and hook-stop)",
  });

  const runtimeHealthPath = path.join(cortexPath, ".governance", "runtime-health.json");
  let runtime: Record<string, unknown> | null = null;
  if (fs.existsSync(runtimeHealthPath)) {
    try { runtime = JSON.parse(fs.readFileSync(runtimeHealthPath, "utf8")); } catch { runtime = null; }
  }
  checks.push({
    name: "runtime-health-file",
    ok: Boolean(runtime),
    detail: runtime ? runtimeHealthPath : "missing or unreadable .governance/runtime-health.json",
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
    const db = await buildIndex(cortexPath, profile || undefined);
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
      detail: `index build/query failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const detected = detectInstalledTools();
  if (detected.has("copilot")) {
    const copilotHooks = path.join(os.homedir(), ".github", "hooks", "cortex.json");
    checks.push({
      name: "copilot-hooks",
      ok: fs.existsSync(copilotHooks),
      detail: fs.existsSync(copilotHooks) ? "copilot hooks config present" : "missing ~/.github/hooks/cortex.json",
    });
  }
  if (detected.has("cursor")) {
    const cursorHooks = path.join(os.homedir(), ".cursor", "hooks.json");
    checks.push({
      name: "cursor-hooks",
      ok: fs.existsSync(cursorHooks),
      detail: fs.existsSync(cursorHooks) ? "cursor hooks config present" : "missing ~/.cursor/hooks.json",
    });
  }
  if (detected.has("codex")) {
    const codexHooks = path.join(cortexPath, "codex.json");
    checks.push({
      name: "codex-hooks",
      ok: fs.existsSync(codexHooks),
      detail: fs.existsSync(codexHooks) ? "codex hooks config present" : "missing codex.json in cortex root",
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

  // Detect unmigrated LEARNINGS.md files and knowledge/ directories
  const projectDirs = fs.readdirSync(cortexPath).filter(d => !d.startsWith('.') && fs.statSync(path.join(cortexPath, d)).isDirectory());
  for (const proj of projectDirs) {
    const oldLearnings = path.join(cortexPath, proj, 'LEARNINGS.md');
    if (fs.existsSync(oldLearnings)) {
      checks.push({ name: `migrate:${proj}/LEARNINGS.md`, ok: false, detail: `${proj}/LEARNINGS.md → run --fix to migrate to FINDINGS.md` });
    }
    const oldKnowledge = path.join(cortexPath, proj, 'knowledge');
    if (fs.existsSync(oldKnowledge)) {
      checks.push({ name: `migrate:${proj}/knowledge`, ok: false, detail: `${proj}/knowledge/ → run --fix to migrate to reference/` });
    }
  }

  if (fix && profile && profileFile) {
    // Migrate LEARNINGS.md → FINDINGS.md
    for (const proj of projectDirs) {
      const oldFile = path.join(cortexPath, proj, 'LEARNINGS.md');
      const newFile = path.join(cortexPath, proj, 'FINDINGS.md');
      if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
        fs.renameSync(oldFile, newFile);
        console.log(`Migrated ${proj}/LEARNINGS.md → FINDINGS.md`);
      }
      // Migrate knowledge/ → reference/
      const oldDir = path.join(cortexPath, proj, 'knowledge');
      const newDir = path.join(cortexPath, proj, 'reference');
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
        console.log(`Migrated ${proj}/knowledge/ → reference/`);
      }
    }
    // Migrate governance files
    const govDir = path.join(cortexPath, '.governance');
    if (fs.existsSync(govDir)) {
      const govRenames: [string, string][] = [
        ['memory-policy.json', 'retention-policy.json'],
        ['memory-workflow-policy.json', 'workflow-policy.json'],
      ];
      for (const [old, next] of govRenames) {
        const oldPath = path.join(govDir, old);
        const newPath = path.join(govDir, next);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
          fs.renameSync(oldPath, newPath);
          console.log(`Migrated .governance/${old} → ${next}`);
        }
      }
    }

    await runLink(cortexPath, { machine, profile });
    checks.push({ name: "self-heal", ok: true, detail: "relinked hooks, symlinks, context, memory pointers" });
  } else if (fix) {
    checks.push({ name: "self-heal", ok: false, detail: "blocked: machine/profile not fully configured" });
  } else {
    // Read-only mode: just check if hook configs exist, don't write anything
    const detectedTools = detectInstalledTools();
    const hookChecks: string[] = [];
    const missing: string[] = [];
    for (const tool of detectedTools) {
      let configPath = "";
      if (tool === "copilot") configPath = path.join(os.homedir(), ".github", "hooks", "cortex.json");
      else if (tool === "cursor") configPath = path.join(os.homedir(), ".cursor", "hooks.json");
      else if (tool === "codex") configPath = path.join(cortexPath, "codex.json");
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
    const governanceChecks: Array<{ file: string; schema: "access-control" | "retention-policy" | "workflow-policy" | "index-policy" | "runtime-health" | "memory-scores" | "canonical-locks" }> = [
      { file: "access-control.json", schema: "access-control" },
      { file: "retention-policy.json", schema: "retention-policy" },
      { file: "workflow-policy.json", schema: "workflow-policy" },
      { file: "index-policy.json", schema: "index-policy" },
      { file: "runtime-health.json", schema: "runtime-health" },
      { file: "memory-scores.json", schema: "memory-scores" },
      { file: "canonical-locks.json", schema: "canonical-locks" },
    ];

    for (const item of governanceChecks) {
      const filePath = path.join(cortexPath, ".governance", item.file);
      const exists = fs.existsSync(filePath);
      const valid = exists ? validateGovernanceJson(filePath, item.schema) : false;
      checks.push({
        name: `data:governance:${item.file}`,
        ok: exists && valid,
        detail: !exists ? "missing governance file" : valid ? "valid" : "invalid JSON/schema",
      });
    }

    for (const projectDir of getProjectDirs(cortexPath, profile)) {
      const projectName = path.basename(projectDir);
      if (projectName === "global") continue;

      const backlogPath = path.join(projectDir, "backlog.md");
      if (fs.existsSync(backlogPath)) {
        const content = fs.readFileSync(backlogPath, "utf8");
        const issues = validateBacklogFormat(content);
        checks.push({
          name: `data:backlog:${projectName}`,
          ok: issues.length === 0,
          detail: issues.length ? issues.join("; ") : "valid",
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

    // Validate skill frontmatter in bundled skills
    const bundledSkills = path.join(cortexPath, "..", "skills");
    const skillResults = validateSkillsDir(fs.existsSync(bundledSkills) ? bundledSkills : path.join(cortexPath, "skills"));
    const invalidSkills = skillResults.filter(r => !r.valid);
    checks.push({
      name: "data:skills-frontmatter",
      ok: invalidSkills.length === 0,
      detail: invalidSkills.length
        ? `${invalidSkills.length} skill(s) with invalid frontmatter: ${invalidSkills.flatMap(r => r.errors).join("; ")}`
        : `${skillResults.length} skill(s) validated`,
    });

    // Validate cortex.SKILL.md manifest
    const manifestPath = path.join(cortexPath, "cortex.SKILL.md");
    if (fs.existsSync(manifestPath)) {
      const manifestResult = validateSkillFrontmatter(fs.readFileSync(manifestPath, "utf8"), manifestPath);
      checks.push({
        name: "data:skill-manifest",
        ok: manifestResult.valid,
        detail: manifestResult.valid ? "cortex.SKILL.md frontmatter valid" : manifestResult.errors.join("; "),
      });
    }

    // Verify file checksums
    const checksumResults = verifyFileChecksums(cortexPath);
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
      updateFileChecksums(cortexPath, profile);
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, machine, profile: profile || undefined, checks };
}
