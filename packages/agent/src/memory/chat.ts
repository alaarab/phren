/**
 * Quick chat: the system prompt for `--mode chat`. No tools, so everything the
 * model knows from phren is read up front, from files only (no index build,
 * no search), to keep the first answer about a second away.
 */
import * as fs from "fs";
import { storeAwareProjectPath } from "@phren/cli/store-routing";
import { readFindings } from "@phren/cli/data/access";
import { readTruths, type PhrenContext } from "./context.js";

/** Budget for the whole memory section; a chat prompt stays small. */
export const CHAT_MEMORY_MAX_CHARS = 12_000;
const RECENT_FINDINGS = 8;

function readSummary(ctx: PhrenContext, project: string): string {
  try {
    const file = storeAwareProjectPath(ctx.phrenPath, project, "summary.md");
    if (!file || !fs.existsSync(file)) return "";
    // The archive block's markers are for the summarizer, not the model.
    return fs.readFileSync(file, "utf-8").replace(/<!--[\s\S]*?-->\n?/g, "").trim();
  } catch {
    return "";
  }
}

/** Read-only phren memory for a quick chat: truths, the project summary and its newest findings. */
export function buildChatMemory(ctx: PhrenContext | null): string {
  if (!ctx) return "";
  const sections: string[] = [];
  const global = readTruths(ctx.phrenPath, "global");
  if (global.length > 0) sections.push(`## Pinned truths (global)\n\n${global.join("\n")}`);
  if (ctx.project && ctx.project !== "global") {
    const truths = readTruths(ctx.phrenPath, ctx.project);
    if (truths.length > 0) sections.push(`## Pinned truths (${ctx.project})\n\n${truths.join("\n")}`);
    const summary = readSummary(ctx, ctx.project);
    if (summary) sections.push(`## Project summary (${ctx.project})\n\n${summary}`);
    try {
      const result = readFindings(ctx.phrenPath, ctx.project);
      if (result.ok && result.data) {
        const recent = result.data
          .filter((f) => f.status === "active" && f.tier !== "archived")
          .slice(-RECENT_FINDINGS)
          .map((f) => `- ${f.text}`);
        if (recent.length > 0) sections.push(`## Recent findings (${ctx.project})\n\n${recent.join("\n")}`);
      }
    } catch { /* silent */ }
  }
  let memory = sections.join("\n\n");
  if (memory.length > CHAT_MEMORY_MAX_CHARS) memory = `${memory.slice(0, CHAT_MEMORY_MAX_CHARS)}\n\n[memory truncated]`;
  return memory;
}

export function buildChatSystemPrompt(memory: string, providerInfo?: { name: string; model?: string }): string {
  const modelNote = providerInfo ? ` You are running on ${providerInfo.name}${providerInfo.model ? ` (model: ${providerInfo.model})` : ""}.` : "";
  const parts = [
    `You are phren, in quick chat with the owner.${modelNote}`,
    "",
    "Answer directly and conversationally, like a chat assistant. Lead with the answer; keep it short unless asked for depth. Replies may be read aloud, so prefer plain sentences over tables and long code.",
    "",
    "You have no tools in this chat: you cannot read files, run commands, search the web or change phren memory. What phren remembers is below. If a request needs tools, say so in one line and suggest /promote, which continues this conversation as a phren agent with tools.",
  ];
  if (memory) parts.push("", "# What phren remembers (read-only)", "", memory);
  return parts.join("\n");
}
