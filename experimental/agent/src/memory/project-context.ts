/**
 * Project context evolution: lightweight LLM reflection at session end
 * and warm-start context loading.
 */
import * as fs from "fs";
import * as path from "path";
import type { PhrenContext } from "./context.js";
import type { LlmProvider, LlmMessage } from "../providers/types.js";

const CONTEXT_FILE = "agent-context.md";
const MAX_DATE_SECTIONS = 3;

function contextPath(ctx: PhrenContext): string | null {
  if (!ctx.project) return null;
  return path.join(ctx.phrenPath, ctx.project, CONTEXT_FILE);
}

/**
 * Load the last N date sections from agent-context.md for warm start.
 */
export function loadProjectContext(ctx: PhrenContext): string {
  const file = contextPath(ctx);
  if (!file || !fs.existsSync(file)) return "";

  try {
    const content = fs.readFileSync(file, "utf-8");
    const sections = content.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(Boolean);
    const recent = sections.slice(-MAX_DATE_SECTIONS);
    return recent.join("\n").trim();
  } catch {
    return "";
  }
}

/**
 * Run a lightweight LLM reflection at session end: one call, two outputs.
 * Key-learning bullets append to agent-context.md (warm start), and candidate
 * knowledge items route through the same graduated confidence pipeline as
 * compaction (≥0.8 finding, 0.5–0.8 review queue, below dropped).
 */
export async function evolveProjectContext(
  ctx: PhrenContext,
  provider: LlmProvider,
  sessionMessages: LlmMessage[],
  opts?: { sessionId?: string | null },
): Promise<void> {
  const file = contextPath(ctx);
  if (!file) return;

  // Build a condensed conversation summary for the reflection prompt
  const condensed = sessionMessages
    .slice(-20) // last 20 messages max
    .map((m) => {
      if (typeof m.content === "string") return `${m.role}: ${m.content.slice(0, 200)}`;
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text.slice(0, 150))
        .join(" ");
      const tools = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => (b as { name: string }).name);
      const parts = [text, tools.length > 0 ? `[tools: ${tools.join(", ")}]` : ""].filter(Boolean);
      return `${m.role}: ${parts.join(" ")}`;
    })
    .join("\n");

  const reflectionPrompt =
    "Based on this conversation excerpt, extract 2-4 key learnings about this project " +
    "(patterns, pitfalls, architecture decisions, important paths/configs). " +
    "Be extremely concise — one line per point. Output only the bullet points, then a final section:\n\n" +
    '## Knowledge\nA fenced json block: {"items":[{"text":"...","confidence":0.9,"kind":"finding|gotcha|decision"}]}\n' +
    'Only durable, non-obvious knowledge worth remembering across sessions. Confidence is YOUR certainty, 0 to 1. Use {"items":[]} if nothing qualifies.\n\n' +
    condensed;

  try {
    const response = await provider.chat(
      "You are a concise technical note-taker.",
      [{ role: "user", content: reflectionPrompt }],
      [],
    );

    const fullText = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();

    // Split off the knowledge section; the bullets before it feed warm start.
    const reflection = fullText.split(/^##\s*Knowledge\b/im)[0].trim();

    // Route extracted knowledge through the graduated pipeline (best effort).
    try {
      const { extractKnowledgeItems, routeKnowledgeItems, resolveCompactionConfig } =
        await import("../context/compactor.js");
      const items = extractKnowledgeItems(fullText);
      if (items.length > 0) {
        await routeKnowledgeItems(items, {
          phrenCtx: ctx,
          sessionId: opts?.sessionId,
          config: resolveCompactionConfig(),
        });
      }
    } catch { /* best effort */ }

    if (!reflection || reflection.length < 10) return;

    const date = new Date().toISOString().slice(0, 10);
    const entry = `\n## ${date}\n\n${reflection}\n`;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, entry);
  } catch {
    // best effort — don't fail the session over this
  }
}
