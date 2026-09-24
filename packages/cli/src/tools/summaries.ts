import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import { type McpContext, type StoreAccessMode, mcpResponse, resolveStoreForProject } from "./types.js";
import { listTopicFiles, parseTopicBullets, readNowBlock, setTopicSummary, summarizeProject } from "../content/summarize.js";

/**
 * Summaries written by the agent itself.
 *
 * phren can write the "## Now" block of a topic archive structurally, and a
 * configured model can write prose. Most people run phren inside an agent
 * that already is a capable model, with no API key and no local runtime: these
 * two tools let that agent do the writing — read the bullets, hand back a
 * paragraph — under the same rule a model's paragraph gets: it may not name
 * anything the bullets do not. The /phren-summarize skill drives them.
 */

function resolve(ctx: McpContext, projectInput: string, mode: StoreAccessMode = "write") {
  try {
    return { ok: true as const, value: resolveStoreForProject(ctx, projectInput, mode) };
  } catch (err: unknown) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export function register(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "get_topic_summaries",
    {
      title: "◆ phren · topic summaries",
      description:
        "What each topic archive of a project amounts to: every reference/topics file with its bullet count, its current '## Now' text and whether that text is structural or prose. " +
        "Pass `topic` to also get that topic's newest bullets, the raw material for writing its paragraph yourself (see /phren-summarize).",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        topic: z.string().optional().describe("A topic slug from the list; returns its newest bullets."),
        bullets: z.number().int().min(5).max(200).optional().describe("How many of the newest bullets to return for `topic`. Defaults to 60."),
      }),
    },
    async ({ project: projectInput, topic, bullets }) => {
      const target = resolve(ctx, projectInput, "read");
      if (!target.ok) return mcpResponse({ ok: false, error: target.error });
      const { phrenPath, project } = target.value;
      const files = listTopicFiles(phrenPath, project);
      const topics = files.map(({ slug, file }) => {
        const content = fs.readFileSync(file, "utf8");
        const parsed = parseTopicBullets(content);
        const now = readNowBlock(content);
        return { topic: slug, bullets: parsed.length, now: now?.text ?? null, structural: now ? now.structural : true, archive: parsed.length > 0 };
      });
      if (!topic) {
        const archives = topics.filter((t) => t.archive);
        return mcpResponse({
          ok: true,
          message: archives.length
            ? `${project}: ${archives.length} topic archive(s), ${archives.filter((t) => !t.structural).length} with a written paragraph.`
            : `${project} has no topic archives yet.`,
          data: { project, topics },
        });
      }
      const chosen = files.find((f) => f.slug === topic);
      if (!chosen) return mcpResponse({ ok: false, error: `No topic "${topic}" in ${project}. Topics: ${files.map((f) => f.slug).join(", ") || "none"}.` });
      const parsed = parseTopicBullets(fs.readFileSync(chosen.file, "utf8"));
      const newest = [...parsed].reverse().slice(0, bullets ?? 60).map((b) => ({ date: b.date, tag: b.tag, text: b.text }));
      return mcpResponse({
        ok: true,
        message: `${project}/${topic}: ${parsed.length} archived bullets, newest ${newest.length} below. Write 4–6 plain sentences using only what they state; name nothing they do not name.`,
        data: { project, topic, total: parsed.length, bullets: newest },
      });
    },
  );

  server.registerTool(
    "set_topic_summary",
    {
      title: "◆ phren · set topic summary",
      description:
        "Store the paragraph you wrote for a topic archive as its '## Now' block, and refresh the project's 'What phren knows' block. " +
        "Refused if the paragraph names anything the topic's bullets do not (the invented names are returned) — fix the paragraph rather than the check.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        topic: z.string().describe("Topic slug, as listed by get_topic_summaries."),
        text: z.string().min(40).describe("Four to six plain sentences. Only facts the bullets state; names spelled as the bullets spell them."),
      }),
    },
    async ({ project: projectInput, topic, text }) => {
      const target = resolve(ctx, projectInput, "write");
      if (!target.ok) return mcpResponse({ ok: false, error: target.error });
      const { phrenPath, project } = target.value;
      const chosen = listTopicFiles(phrenPath, project).find((f) => f.slug === topic);
      if (!chosen) return mcpResponse({ ok: false, error: `No topic "${topic}" in ${project}.` });
      return ctx.withWriteQueue(async () => {
        const result = setTopicSummary(chosen.file, text);
        if (!result.ok) {
          if ("invented" in result) return mcpResponse({ ok: false, error: `Refused: the paragraph names things the bullets do not: ${result.invented.join(", ")}. Remove or rename them and try again.`, data: { invented: result.invented } });
          return mcpResponse({ ok: false, error: result.error });
        }
        const summary = await summarizeProject(phrenPath, project, {});
        try { ctx.updateFileInIndex(chosen.file); } catch { /* index refresh is best-effort */ }
        return mcpResponse({ ok: true, message: `Stored the paragraph for ${project}/${topic}${summary.summaryUpdated ? " and refreshed summary.md" : ""}.`, data: { project, topic, summaryUpdated: summary.summaryUpdated } });
      });
    },
  );
}
