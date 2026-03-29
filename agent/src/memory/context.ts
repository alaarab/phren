import * as fs from "fs";
import * as path from "path";
import { importPhrenPaths, importRuntimeProfile, importIndex, importRetrieval, importTasks, importFindings } from "../phren-imports.js";

export interface PhrenContext {
  phrenPath: string;
  profile: string;
  project: string | null;
}

/** Try to find phren path and detect the active project from cwd. */
export async function buildPhrenContext(projectOverride?: string): Promise<PhrenContext | null> {
  try {
    const { findPhrenPath } = await importPhrenPaths();
    const phrenPath = findPhrenPath();
    if (!phrenPath || !fs.existsSync(phrenPath)) return null;

    let profile = "";
    try {
      const { resolveRuntimeProfile } = await importRuntimeProfile();
      profile = resolveRuntimeProfile(phrenPath) ?? "";
    } catch { /* no profile */ }

    let project: string | null = projectOverride ?? null;
    if (!project) {
      try {
        const { getProjectDirs } = await importPhrenPaths();
        const projectDirs = getProjectDirs(phrenPath, profile || undefined);
        const cwd = process.cwd();
        for (const dir of projectDirs) {
          const name = path.basename(dir);
          try {
            const configPath = path.join(dir, "project.yaml");
            if (fs.existsSync(configPath)) {
              const content = fs.readFileSync(configPath, "utf-8");
              const sourceMatch = content.match(/source:\s*(.+)/);
              if (sourceMatch?.[1]) {
                const sourcePath = sourceMatch[1].trim().replace(/^['"]|['"]$/g, "");
                if (cwd.startsWith(sourcePath) || cwd === sourcePath) {
                  project = name;
                  break;
                }
              }
            }
          } catch { /* skip */ }
          if (path.basename(cwd) === name) {
            project = name;
            break;
          }
        }
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
    const truthsPath = path.join(phrenPath, project, "truths.md");
    if (!fs.existsSync(truthsPath)) return [];
    const content = fs.readFileSync(truthsPath, "utf-8");
    return content.split("\n").filter((line) => line.startsWith("- "));
  } catch {
    return [];
  }
}

/** Read source path from project.yaml. */
function readProjectSourcePath(phrenPath: string, project: string): string | null {
  try {
    const configPath = path.join(phrenPath, project, "project.yaml");
    if (!fs.existsSync(configPath)) return null;
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/source:\s*(.+)/);
    if (!match?.[1]) return null;
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return null;
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
      const { readTasks: read } = await importTasks();
      const result = read(ctx.phrenPath, ctx.project);
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
      const { readFindings } = await importFindings();
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

  // Section 4: Project CLAUDE.md
  if (ctx.project) {
    try {
      const sourcePath = readProjectSourcePath(ctx.phrenPath, ctx.project);
      if (sourcePath) {
        const claudePath = path.join(sourcePath, "CLAUDE.md");
        if (fs.existsSync(claudePath)) {
          const content = fs.readFileSync(claudePath, "utf-8").slice(0, 800);
          sections.push(`## Project CLAUDE.md (${label})\n\n${content}`);
        }
      }
    } catch { /* silent */ }
  }

  // Section 5: FTS5 search
  try {
    const { buildIndex } = await importIndex();
    const { searchKnowledgeRows, rankResults } = await importRetrieval();

    const db = await buildIndex(ctx.phrenPath, ctx.profile || undefined);
    const rows = searchKnowledgeRows(db, taskKeywords, {
      limit: 10,
      project: ctx.project || undefined,
    });
    const ranked = rankResults(db, rows, taskKeywords, { project: ctx.project || undefined });

    if (ranked.length > 0) {
      const snippets = ranked.slice(0, 5).map((r) => {
        const content = r.content?.slice(0, 400) ?? "";
        return `[${r.project}/${r.filename}] ${content}`;
      });
      sections.push(`## Related knowledge (${label})\n\n${snippets.join("\n\n")}`);
    }
  } catch { /* silent */ }

  return sections.join("\n\n");
}
