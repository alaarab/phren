/**
 * Memory commands: /mem, /ask
 */
import type { CommandContext } from "../commands.js";
import { renderMarkdown } from "../multi/markdown.js";
import { buildIndex } from "@phren/cli/shared";
import { searchKnowledgeRows, rankResults } from "@phren/cli/shared/retrieval";
import { readFindings } from "@phren/cli/data/access";
import { readTasks } from "@phren/cli/data/tasks";
import { addFinding } from "@phren/cli/core/finding";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function memCommand(parts: string[], ctx: CommandContext): boolean | Promise<boolean> {
  const sub = parts[1]?.toLowerCase();
  if (!ctx.phrenCtx) {
    process.stderr.write(`${DIM}No phren context available.${RESET}\n`);
    return true;
  }
  const pCtx = ctx.phrenCtx;

  if (!sub || sub === "help") {
    process.stderr.write(`${DIM}Usage:
  /mem search <query>     Search phren memory
  /mem findings [project] Show recent findings
  /mem tasks [project]    Show tasks
  /mem add <finding>      Quick-add a finding${RESET}\n`);
    return true;
  }

  if (sub === "search") {
    const query = parts.slice(2).join(" ").trim();
    if (!query) {
      process.stderr.write(`${DIM}Usage: /mem search <query>${RESET}\n`);
      return true;
    }
    return (async () => {
      try {
        const db = await buildIndex(pCtx.phrenPath, pCtx.profile);
        const result = await searchKnowledgeRows(db, {
          query,
          maxResults: 10,
          filterProject: pCtx.project || null,
          filterType: null,
          phrenPath: pCtx.phrenPath,
        });
        const ranked = rankResults(result.rows ?? [], query, null, pCtx.project || null, pCtx.phrenPath, db);
        if (ranked.length === 0) {
          process.stderr.write(`${DIM}No results found.${RESET}\n`);
        } else {
          const lines = ranked.slice(0, 10).map((r: { project: string; filename: string; content?: string }, i: number) => {
            const snippet = r.content?.slice(0, 200) ?? "";
            return `  ${CYAN}${i + 1}.${RESET} ${DIM}[${r.project}/${r.filename}]${RESET} ${snippet}`;
          });
          process.stderr.write(lines.join("\n") + "\n");
        }
      } catch (err: unknown) {
        process.stderr.write(`${RED}Search failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
      }
      return true;
    })();
  }

  if (sub === "findings") {
    const project = parts[2] || pCtx.project;
    if (!project) {
      process.stderr.write(`${DIM}Usage: /mem findings <project>${RESET}\n`);
      return true;
    }
    const result = readFindings(pCtx.phrenPath, project);
    if (!result.ok) {
      process.stderr.write(`${RED}${result.error}${RESET}\n`);
      return true;
    }
    const items = result.data ?? [];
    if (items.length === 0) {
      process.stderr.write(`${DIM}No findings for ${project}.${RESET}\n`);
      return true;
    }
    const recent = items.slice(-15);
    const lines = recent.map((f: { id: string; date: string; text: string }) =>
      `  ${DIM}${f.date}${RESET} ${f.text.slice(0, 120)}${f.text.length > 120 ? "..." : ""}`
    );
    process.stderr.write(`${DIM}-- Findings (${items.length} total, showing last ${recent.length}) --${RESET}\n`);
    process.stderr.write(lines.join("\n") + "\n");
    return true;
  }

  if (sub === "tasks") {
    const project = parts[2] || pCtx.project;
    if (!project) {
      process.stderr.write(`${DIM}Usage: /mem tasks <project>${RESET}\n`);
      return true;
    }
    const result = readTasks(pCtx.phrenPath, project);
    if (!result.ok) {
      process.stderr.write(`${RED}${result.error}${RESET}\n`);
      return true;
    }
    const sections: string[] = [];
    for (const [section, items] of Object.entries(result.data!.items)) {
      if (section === "Done") continue;
      if (items.length === 0) continue;
      const lines = items.map((t: { checked: boolean; line: string }) => {
        const icon = t.checked ? `${GREEN}\u2713${RESET}` : `${DIM}\u25CB${RESET}`;
        return `  ${icon} ${t.line}`;
      });
      sections.push(`${BOLD}${section}${RESET}\n${lines.join("\n")}`);
    }
    if (sections.length === 0) {
      process.stderr.write(`${DIM}No active tasks for ${project}.${RESET}\n`);
    } else {
      process.stderr.write(sections.join("\n") + "\n");
    }
    return true;
  }

  if (sub === "add") {
    const finding = parts.slice(2).join(" ").trim();
    if (!finding) {
      process.stderr.write(`${DIM}Usage: /mem add <finding text>${RESET}\n`);
      return true;
    }
    const project = pCtx.project;
    if (!project) {
      process.stderr.write(`${DIM}No project context. Cannot add finding without a project.${RESET}\n`);
      return true;
    }
    const result = addFinding(pCtx.phrenPath, project, finding);
    if (result.ok) {
      process.stderr.write(`${GREEN}-> Finding saved to ${project}.${RESET}\n`);
    } else {
      process.stderr.write(`${RED}${result.message ?? "Failed to save finding."}${RESET}\n`);
    }
    return true;
  }

  process.stderr.write(`${DIM}Unknown /mem subcommand: ${sub}. Try /mem help${RESET}\n`);
  return true;
}

export function askCommand(parts: string[], ctx: CommandContext): boolean | Promise<boolean> {
  const question = parts.slice(1).join(" ").trim();
  if (!question) {
    process.stderr.write(`${DIM}Usage: /ask <question>${RESET}\n`);
    return true;
  }
  if (!ctx.provider) {
    process.stderr.write(`${DIM}Provider not available for /ask.${RESET}\n`);
    return true;
  }
  const provider = ctx.provider;
  const sysPrompt = ctx.systemPrompt ?? "You are a helpful assistant.";
  return (async () => {
    process.stderr.write(`${DIM}\u25C6 quick answer (no tools):${RESET}\n`);
    try {
      const response = await provider.chat(sysPrompt, [{ role: "user", content: question }], []);
      for (const block of response.content) {
        if (block.type === "text") {
          process.stderr.write(renderMarkdown(block.text) + "\n");
        }
      }
    } catch (err: unknown) {
      process.stderr.write(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
    return true;
  })();
}
