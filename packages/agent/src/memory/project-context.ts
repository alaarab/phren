/**
 * Project context evolution: lightweight LLM reflection at session end
 * and warm-start context loading.
 */
import * as fs from "fs";
import * as path from "path";
import type { PhrenContext } from "./context.js";
import type { LlmProvider, LlmMessage } from "../providers/types.js";
import { checkFindingIntegrity } from "../permissions/privacy.js";

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
 * Run a lightweight LLM reflection at session end and append to agent-context.md.
 * Summarizes key learnings from the conversation.
 */
export async function evolveProjectContext(
  ctx: PhrenContext,
  provider: LlmProvider,
  sessionMessages: LlmMessage[],
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
    "Be extremely concise — one line per point. Output only the bullet points, nothing else.\n\n" +
    condensed;

  try {
    const response = await provider.chat(
      "You are a concise technical note-taker.",
      [{ role: "user", content: reflectionPrompt }],
      [],
    );

    const reflection = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();

    if (!reflection || reflection.length < 10) return;

    // Integrity check: LLM reflection could be poisoned via adversarial conversation content.
    // Check each line individually since the reflection is multi-line bullet points.
    const integrity = checkFindingIntegrity(reflection);
    if (!integrity.safe) return;

    const date = new Date().toISOString().slice(0, 10);
    const entry = `\n## ${date}\n\n${reflection}\n`;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, entry);
  } catch {
    // best effort — don't fail the session over this
  }
}
