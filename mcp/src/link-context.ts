import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";
import { isRecord } from "./shared.js";

const CONTEXT_FILE = path.join(os.homedir(), ".cortex-context.md");

function log(msg: string) { process.stdout.write(msg + "\n"); }

// Cross-platform home directory helper
function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function claudeProjectKey(): string {
  return homeDir().replace(/[/\\:]/g, "-").replace(/^-/, "");
}

function displayName(slug: string): string {
  if (!slug) return "";
  return slug.split("-").map(w => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

function allKnownProjects(cortexPath: string): string[] {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return [];
  const projects = new Set<string>();
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".yaml")) continue;
    const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8"), { schema: yaml.CORE_SCHEMA }) as { projects?: string[] } | undefined;
    for (const p of (data?.projects ?? [])) projects.add(p);
  }
  return [...projects].sort();
}

// ── Context file writing ────────────────────────────────────────────────────

export function writeContextFile(managedContent: string) {
  const wrapped = `<!-- cortex-managed -->\n${managedContent}\n<!-- /cortex-managed -->`;
  if (fs.existsSync(CONTEXT_FILE)) {
    const existing = fs.readFileSync(CONTEXT_FILE, "utf8");
    if (existing.includes("<!-- cortex-managed -->")) {
      const startIdx = existing.indexOf("<!-- cortex-managed -->");
      const endIdx = existing.indexOf("<!-- /cortex-managed -->");
      const before = startIdx > 0 ? existing.slice(0, startIdx).trimEnd() : "";
      const after = endIdx !== -1 ? existing.slice(endIdx + "<!-- /cortex-managed -->".length).trimStart() : "";
      const parts = [before, wrapped, after].filter(Boolean);
      fs.writeFileSync(CONTEXT_FILE, parts.join("\n") + "\n");
      return;
    }
  }
  fs.writeFileSync(CONTEXT_FILE, wrapped + "\n");
}

export function formatMcpStatus(status: string): string {
  if (status === "installed" || status === "already_configured") {
    return "MCP: active (search_cortex, get_project_summary, list_projects)";
  }
  if (status === "disabled" || status === "already_disabled") {
    return "MCP: disabled (hooks-only fallback active)";
  }
  if (status === "not_built") return "MCP: not built. Run: cd mcp && npm install && npm run build";
  return "";
}

export function writeContextDefault(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const all = allKnownProjects(cortexPath);
  const inactive = all.filter(p => !projects.includes(p));
  const mcpLine = formatMcpStatus(mcpStatus);
  const lines = [
    "# cortex context",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Active projects: ${projects.join(", ")}`,
    `Not on this machine: ${inactive.length ? inactive.join(", ") : "none"}`,
    ...(mcpLine ? [mcpLine] : []),
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
  ];
  writeContextFile(lines.join("\n"));
  log(`  wrote ${CONTEXT_FILE}`);
}

export function writeContextDebugging(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = [
    "# cortex context (debugging)",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
    ...(mcpLine ? [mcpLine] : []),
  ].join("\n") + "\n\n## Project Findings\n";

  const MAX_FILE_BYTES = 50 * 1024;
  for (const project of projects) {
    if (project === "global") continue;
    const findings = path.join(cortexPath, project, "FINDINGS.md");
    if (fs.existsSync(findings)) {
      let body = fs.readFileSync(findings, "utf8");
      if (body.length > MAX_FILE_BYTES) {
        body = body.slice(-MAX_FILE_BYTES);
        const firstNewline = body.indexOf("\n");
        if (firstNewline !== -1) body = body.slice(firstNewline + 1);
        body = `(truncated to most recent entries)\n${body}`;
      }
      content += `\n### ${project}\n${body}\n`;
    }
  }
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (debugging mode)`);
}

export function writeContextPlanning(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = [
    "# cortex context (planning)",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
    ...(mcpLine ? [mcpLine] : []),
  ].join("\n");

  const MAX_CONTEXT_BYTES = 100 * 1024;
  for (const project of projects) {
    if (project === "global") continue;
    if (content.length >= MAX_CONTEXT_BYTES) {
      content += `\n\n(remaining projects truncated, context size limit reached)\n`;
      break;
    }
    const summaryFile = path.join(cortexPath, project, "summary.md");
    const backlogFile = path.join(cortexPath, project, "backlog.md");
    if (!fs.existsSync(summaryFile) && !fs.existsSync(backlogFile)) continue;
    content += `\n\n## ${project}\n`;
    if (fs.existsSync(summaryFile)) content += fs.readFileSync(summaryFile, "utf8") + "\n";
    if (fs.existsSync(backlogFile)) {
      let backlog = fs.readFileSync(backlogFile, "utf8");
      const remaining = MAX_CONTEXT_BYTES - content.length;
      if (backlog.length > remaining && remaining > 0) {
        backlog = backlog.slice(0, remaining) + "\n(backlog truncated)\n";
      }
      content += `\n### Backlog\n${backlog}\n`;
    }
  }
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (planning mode)`);
}

export function writeContextClean(machine: string, profile: string, mcpStatus: string, projects: string[]) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = `# cortex context (clean)\nMachine: ${machine} | Profile: ${profile} | Projects: ${projects.join(", ")}\n`;
  if (mcpLine) content += mcpLine + "\n";
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (clean mode)`);
}

// ── Memory management ───────────────────────────────────────────────────────

export function readBackNativeMemory(cortexPath: string, projects: string[]) {
  const projectKey = claudeProjectKey();
  const memoryDir = path.join(homeDir(), ".claude", "projects", projectKey, "memory");
  if (!fs.existsSync(memoryDir)) return;

  for (const project of projects) {
    if (project === "global") continue;
    const nativeFile = path.join(memoryDir, `MEMORY-${project}.md`);
    if (!fs.existsSync(nativeFile)) continue;

    const content = fs.readFileSync(nativeFile, "utf8");
    const notesMatch = content.match(/^## Notes\n([\s\S]*)$/m);
    if (!notesMatch) continue;

    const notes = notesMatch[1]
      .replace(/<!-- Session findings, patterns, decisions -->\n?/, "")
      .trim();
    if (!notes) continue;

    const targetFile = path.join(cortexPath, project, "native-notes.md");
    const existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8").trim() : "";
    if (existing === notes) continue;

    fs.mkdirSync(path.join(cortexPath, project), { recursive: true });
    fs.writeFileSync(targetFile, notes + "\n");
    log(`  synced native memory notes for ${project}`);
  }
}

export function rebuildMemory(cortexPath: string, projects: string[]) {
  const projectKey = claudeProjectKey();
  const memoryDir = path.join(homeDir(), ".claude", "projects", projectKey, "memory");
  const memoryFile = path.join(memoryDir, "MEMORY.md");

  const hasSummaries = projects.some(p =>
    p !== "global" && fs.existsSync(path.join(cortexPath, p, "summary.md"))
  );
  if (!hasSummaries) return;

  fs.mkdirSync(memoryDir, { recursive: true });

  let header = "";
  if (fs.existsSync(memoryFile)) {
    const existing = fs.readFileSync(memoryFile, "utf8");
    const idx = existing.indexOf("<!-- cortex:projects:start -->");
    if (idx !== -1) header = existing.slice(0, idx);
  }

  let managed = "<!-- cortex:projects:start -->\n<!-- Auto-generated by cortex link. Do not edit below this line. -->\n\n## Active Projects\n\n| Project | What | Memory |\n|---------|------|--------|\n";
  for (const project of projects) {
    if (project === "global") continue;
    const summaryFile = path.join(cortexPath, project, "summary.md");
    if (!fs.existsSync(summaryFile)) continue;
    const summary = fs.readFileSync(summaryFile, "utf8");
    const whatMatch = summary.match(/^\*\*What:\*\*\s*(.+)/m);
    const what = whatMatch?.[1]?.trim() ?? "(see summary)";
    managed += `| ${displayName(project)} | ${what} | MEMORY-${project}.md |\n`;
  }
  managed += "\n<!-- cortex:projects:end -->";

  const freshHeader = "# Root Memory\n\n## Machine Context\nRead `~/.cortex-context.md` for profile, active projects, last sync date.\n\n## Cross-Project Notes\n- Read a project's CLAUDE.md before making changes.\n- Per-project memory files (MEMORY-{name}.md) have commands, versions, findings.\n\n";
  fs.writeFileSync(memoryFile, (header || freshHeader) + managed + "\n");
  log(`  rebuilt ${memoryFile} (pointer format)`);

  for (const project of projects) {
    if (project === "global") continue;
    const summaryFile = path.join(cortexPath, project, "summary.md");
    if (!fs.existsSync(summaryFile)) continue;
    const projectMemory = path.join(memoryDir, `MEMORY-${project}.md`);
    if (!fs.existsSync(projectMemory)) {
      fs.writeFileSync(projectMemory, `# ${displayName(project)}\n\n${fs.readFileSync(summaryFile, "utf8")}\n\n## Notes\n<!-- Session findings, patterns, decisions -->\n`);
      log(`  created ${projectMemory}`);
    }
  }
}
