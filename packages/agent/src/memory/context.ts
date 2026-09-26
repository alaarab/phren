import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findPhrenPath } from "@phren/cli/paths";
import { resolveRuntimeProfile } from "@phren/cli/runtime-profile";
import { buildIndex, detectProject } from "@phren/cli/shared";
import { searchKnowledgeRows, rankResults, isInjectableDocType } from "@phren/cli/shared/retrieval";
import { storeAwareProjectPath } from "@phren/cli/store-routing";
import { readTasks } from "@phren/cli/data/tasks";
import { readFindings } from "@phren/cli/data/access";

export interface PhrenContext {
  phrenPath: string;
  profile: string;
  project: string | null;
}

/** Try to find phren path and detect the active project from cwd. */
export async function buildPhrenContext(projectOverride?: string): Promise<PhrenContext | null> {
  try {
    const phrenPath = findPhrenPath();
    if (!phrenPath || !fs.existsSync(phrenPath)) return null;

    let profile = "";
    try {
      profile = resolveRuntimeProfile(phrenPath) ?? "";
    } catch { /* no profile */ }

    let project: string | null = projectOverride ?? null;
    if (!project) {
      try {
        // The CLI's own resolver: reads phren.project.yaml sourcePath entries,
        // handles project-local installs, team stores, git worktrees, and picks
        // the longest matching sourcePath so nested projects resolve correctly.
        project = detectProject(phrenPath, process.cwd(), profile || undefined);
      } catch { /* no project detection */ }
    }

    return { phrenPath, profile, project };
  } catch {
    return null;
  }
}

/** Read truths.md pinned entries for a project. */
function readTruths(phrenPath: string, project: string): string[] {
  try {
    // Store-aware: upsertCanonical writes via storeAwareProjectPath, so team-store
    // truths live under the store root, not necessarily <phrenPath>/<project>/.
    const truthsPath = storeAwareProjectPath(phrenPath, project, "truths.md")
      ?? path.join(phrenPath, project, "truths.md");
    if (!fs.existsSync(truthsPath)) return [];
    const content = fs.readFileSync(truthsPath, "utf-8");
    return content.split("\n").filter((line) => line.startsWith("- "));
  } catch {
    return [];
  }
}

/**
 * Budget for all instruction files together. Codex's default is 32 KiB; the
 * old 4,000-char cap cut a typical monorepo AGENTS.md off after its first
 * screen.
 */
export const RULE_FILES_MAX_CHARS = 32_000;

/**
 * Collect project rule files (AGENTS.md and legacy CLAUDE.md) by walking up from cwd
 * to the filesystem root, then checking the user-level ~/.claude/CLAUDE.md.
 * Returns entries most-specific first (cwd → parent → ... → user-level).
 */
function collectRuleFiles(): { filePath: string; content: string }[] {
  const seen = new Set<string>();
  const results: { filePath: string; content: string }[] = [];
  const read = (resolved: string) => {
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      if (fs.existsSync(resolved)) {
        const content = fs.readFileSync(resolved, "utf-8").trim();
        if (content) results.push({ filePath: resolved, content });
      }
    } catch { /* skip unreadable */ }
  };

  let dir = process.cwd();
  while (true) {
    read(path.resolve(dir, "AGENTS.md"));
    read(path.resolve(dir, "CLAUDE.md"));
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  read(path.resolve(os.homedir(), ".claude", "CLAUDE.md"));

  return results;
}

/**
 * The "## Project instructions" section from AGENTS.md / CLAUDE.md files, or
 * "" when there are none. Independent of a phren store: a repo's own
 * instructions apply whether or not phren memory is set up.
 */
export function buildProjectInstructions(maxChars = RULE_FILES_MAX_CHARS): string {
  try {
    const ruleFiles = collectRuleFiles();
    if (ruleFiles.length === 0) return "";
    let combined = ruleFiles
      .map((f) => `<!-- ${f.filePath} -->\n${f.content}`)
      .join("\n\n---\n\n");
    if (combined.length > maxChars) {
      combined = combined.slice(0, maxChars) + "\n\n<!-- truncated -->";
    }
    return `## Project instructions\n\n${combined}`;
  } catch {
    return "";
  }
}

/** Build a context string from phren knowledge to inject into the system prompt. */
export async function buildContextSnippet(ctx: PhrenContext, taskKeywords: string): Promise<string> {
  const sections: string[] = [];
  const label = ctx.project ?? "global";

  // Section 1: Pinned truths
  if (ctx.project) {
    try {
      const truths = readTruths(ctx.phrenPath, ctx.project);
      if (truths.length > 0) {
        sections.push(`## Pinned truths (${label})\n\n${truths.join("\n")}`);
      }
    } catch { /* silent */ }
  }

  // Section 2: Active tasks
  if (ctx.project) {
    try {
      const result = readTasks(ctx.phrenPath, ctx.project);
      if (result.ok && result.data) {
        const items = result.data.items;
        const lines: string[] = [];
        const active = items.Active?.slice(0, 5) ?? [];
        const queue = items.Queue?.slice(0, 3) ?? [];
        for (const t of active) lines.push(`- [Active] ${t.line}`);
        for (const t of queue) lines.push(`- [Queue] ${t.line}`);
        if (lines.length > 0) {
          sections.push(`## Tasks (${label})\n\n${lines.join("\n")}`);
        }
      }
    } catch { /* silent */ }
  }

  // Section 3: Recent findings
  if (ctx.project) {
    try {
      const result = readFindings(ctx.phrenPath, ctx.project);
      if (result.ok && result.data) {
        const active = result.data
          .filter((f) => f.status === "active" && f.tier !== "archived")
          .slice(-5);
        if (active.length > 0) {
          const lines = active.map((f) => `- ${f.text}`);
          sections.push(`## Recent findings (${label})\n\n${lines.join("\n")}`);
        }
      }
    } catch { /* silent */ }
  }

  // Section 4: project rule files (AGENTS.md / legacy CLAUDE.md), cwd → parents → ~/.claude/CLAUDE.md
  const instructions = buildProjectInstructions();
  if (instructions) sections.push(instructions);

  // Section 5: Available skills catalog — the model should know what skills
  // exist (name + description) instead of guessing names for run_skill.
  try {
    const { getScopedSkills } = await import("@phren/cli/skill/registry");
    const skills = getScopedSkills(ctx.phrenPath, ctx.profile, ctx.project ?? undefined)
      .filter((s) => s.enabled);
    if (skills.length > 0) {
      const lines = skills.slice(0, 20).map(
        (s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""}`,
      );
      sections.push(`## Available skills (invoke with run_skill)\n\n${lines.join("\n")}`);
    }
  } catch { /* silent */ }

  // Section 6: Review queue awareness — count + top items, clearly labeled as
  // unverified so candidates are visible without leaking as facts.
  if (ctx.project) {
    try {
      const { getQueueStatus, formatQueueContextSection } = await import("./review-triage.js");
      const section = formatQueueContextSection(getQueueStatus(ctx, 3));
      if (section) sections.push(section);
    } catch { /* silent */ }
  }

  // Section 7: FTS5 search
  try {
    const db = await buildIndex(ctx.phrenPath, ctx.profile || undefined);
    const result = await searchKnowledgeRows(db, {
      query: taskKeywords,
      maxResults: 10,
      filterProject: ctx.project || null,
      filterType: null,
      phrenPath: ctx.phrenPath,
    });
    const ranked = rankResults(result.rows ?? [], taskKeywords, null, ctx.project || null, ctx.phrenPath, db);

    // Automatic injection path: drop non-injectable doc types (notes, review-queue).
    // Notes are the user's private scratch space and review.md is a quarantine of
    // unapproved candidates — neither may reach a prompt without an explicit search.
    const injectable = ranked.filter((r: { type?: string }) => isInjectableDocType(r.type ?? ""));

    if (injectable.length > 0) {
      const snippets = injectable.slice(0, 5).map((r: { project: string; filename: string; content?: string }) => {
        const content = r.content?.slice(0, 400) ?? "";
        return `[${r.project}/${r.filename}] ${content}`;
      });
      sections.push(`## Related knowledge (${label})\n\n${snippets.join("\n\n")}`);
    }
  } catch { /* silent */ }

  return sections.join("\n\n");
}
