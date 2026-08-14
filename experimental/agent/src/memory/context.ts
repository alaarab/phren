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

const CLAUDE_MD_MAX_CHARS = 4000;

/**
 * Collect CLAUDE.md files by walking up from cwd to the filesystem root,
 * then checking the user-level ~/.claude/CLAUDE.md.
 * Returns entries most-specific first (cwd → parent → ... → user-level).
 */
function collectClaudeMdFiles(): { filePath: string; content: string }[] {
  const seen = new Set<string>();
  const results: { filePath: string; content: string }[] = [];

  // Walk from cwd up to root
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, "CLAUDE.md");
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      try {
        if (fs.existsSync(resolved)) {
          const content = fs.readFileSync(resolved, "utf-8").trim();
          if (content) {
            results.push({ filePath: resolved, content });
          }
        }
      } catch { /* skip unreadable */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  // Check user-level ~/.claude/CLAUDE.md
  const userLevel = path.resolve(os.homedir(), ".claude", "CLAUDE.md");
  if (!seen.has(userLevel)) {
    seen.add(userLevel);
    try {
      if (fs.existsSync(userLevel)) {
        const content = fs.readFileSync(userLevel, "utf-8").trim();
        if (content) {
          results.push({ filePath: userLevel, content });
        }
      }
    } catch { /* skip */ }
  }

  return results;
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

  // Section 4: CLAUDE.md hierarchy (cwd → parent dirs → ~/.claude/CLAUDE.md)
  try {
    const claudeFiles = collectClaudeMdFiles();
    if (claudeFiles.length > 0) {
      let combined = claudeFiles
        .map((f) => `<!-- ${f.filePath} -->\n${f.content}`)
        .join("\n\n---\n\n");
      if (combined.length > CLAUDE_MD_MAX_CHARS) {
        combined = combined.slice(0, CLAUDE_MD_MAX_CHARS) + "\n\n<!-- truncated -->";
      }
      sections.push(`## CLAUDE.md\n\n${combined}`);
    }
  } catch { /* silent */ }

  // Section 5: FTS5 search
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
