import { findCortexPath, buildIndex, extractSnippet, queryRows, detectProject, addLearningToFile } from "./shared.js";
import { sanitizeFts5Query, expandSynonyms, extractKeywords } from "./utils.js";
import * as fs from "fs";
import * as path from "path";

const cortexPath = findCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

export async function runCliCommand(command: string, args: string[]) {
  switch (command) {
    case "search":
      return handleSearch(args.join(" "));
    case "hook-prompt":
      return handleHookPrompt();
    case "hook-context":
      return handleHookContext();
    case "add-learning":
      return handleAddLearning(args[0], args.slice(1).join(" "));
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

async function handleSearch(rawQuery: string) {
  if (!rawQuery.trim()) {
    console.error("Usage: cortex search <query>");
    process.exit(1);
  }

  const db = await buildIndex(cortexPath, profile);
  const safeQuery = expandSynonyms(sanitizeFts5Query(rawQuery));
  if (!safeQuery) {
    console.error("Query empty after sanitization.");
    process.exit(1);
  }

  try {
    const rows = queryRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 3",
      [safeQuery]
    );

    if (!rows) {
      process.exit(0);
    }

    for (const row of rows) {
      const [project, filename, docType, content] = row as string[];
      const snippet = extractSnippet(content, rawQuery);
      console.log(`[${project}/${filename}] (${docType})`);
      console.log(snippet);
      console.log();
    }
  } catch (err: any) {
    console.error(`Search error: ${err.message}`);
    process.exit(1);
  }
}

async function handleHookPrompt() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  let prompt: string;
  let cwd: string | undefined;
  try {
    const data = JSON.parse(input);
    prompt = data.prompt || "";
    cwd = data.cwd;
  } catch {
    process.exit(0);
  }

  if (!prompt.trim()) process.exit(0);

  const keywords = extractKeywords(prompt);
  if (!keywords) process.exit(0);

  const db = await buildIndex(cortexPath, profile);

  // Detect project from cwd to boost relevant results
  const detectedProject = cwd ? detectProject(cortexPath, cwd, profile) : null;

  const safeQuery = expandSynonyms(sanitizeFts5Query(keywords));
  if (!safeQuery) process.exit(0);

  try {
    // If we know the project, search within it first, then fall back to global
    let rows: any[][] | null = null;

    if (detectedProject) {
      rows = queryRows(
        db,
        "SELECT project, filename, type, content FROM docs WHERE docs MATCH ? AND project = ? ORDER BY rank LIMIT 3",
        [safeQuery, detectedProject]
      );
    }

    // Fall back to global search if no project-specific results
    if (!rows) {
      rows = queryRows(
        db,
        "SELECT project, filename, type, content FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 3",
        [safeQuery]
      );
    }

    if (!rows) process.exit(0);

    const parts: string[] = ["<cortex-context>"];
    for (const row of rows) {
      const [project, filename, docType, content] = row as string[];
      const snippet = extractSnippet(content, keywords, 8);
      parts.push(`[${project}/${filename}] (${docType})`);
      parts.push(snippet);
      parts.push("");
    }
    parts.push("</cortex-context>");

    console.log(parts.join("\n"));
  } catch {
    process.exit(0);
  }
}

async function handleHookContext() {
  // SessionStart hook provides stdin JSON with cwd and source
  let cwd = process.cwd();
  try {
    const input = fs.readFileSync(0, "utf-8");
    const data = JSON.parse(input);
    if (data.cwd) cwd = data.cwd;
  } catch {
    // No stdin or invalid JSON, fall back to process.cwd()
  }

  const project = detectProject(cortexPath, cwd, profile);

  const db = await buildIndex(cortexPath, profile);
  const parts: string[] = ["<cortex-context>"];

  if (project) {
    // Project-specific context
    const summaryRow = queryRows(db, "SELECT content FROM docs WHERE project = ? AND type = 'summary'", [project]);
    if (summaryRow) {
      parts.push(`# ${project}`);
      parts.push(summaryRow[0][0] as string);
      parts.push("");
    }

    const learningsRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'learnings'",
      [project]
    );
    if (learningsRow) {
      const content = learningsRow[0][0] as string;
      // Get the last 10 learnings
      const bullets = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 10);
      if (bullets.length > 0) {
        parts.push("## Recent learnings");
        parts.push(bullets.join("\n"));
        parts.push("");
      }
    }

    const backlogRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'backlog'",
      [project]
    );
    if (backlogRow) {
      const content = backlogRow[0][0] as string;
      const activeItems = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 5);
      if (activeItems.length > 0) {
        parts.push("## Active backlog");
        parts.push(activeItems.join("\n"));
        parts.push("");
      }
    }
  } else {
    // No project detected, show general overview
    const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
    if (projectRows) {
      parts.push("# Cortex projects");
      parts.push(projectRows.map(r => `- ${r[0]}`).join("\n"));
      parts.push("");
    }
  }

  parts.push("</cortex-context>");

  // Only output if we have actual content
  if (parts.length > 2) {
    console.log(parts.join("\n"));
  }
}

async function handleAddLearning(project: string, learning: string) {
  if (!project || !learning) {
    console.error('Usage: cortex add-learning <project> "<insight>"');
    process.exit(1);
  }

  const result = addLearningToFile(cortexPath, project, learning);
  console.log(result);
}
