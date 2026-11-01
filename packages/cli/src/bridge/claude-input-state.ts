import { classifyClaudeInput, type InputClassification } from "./input-classification.js";
import { object, objects, type Json } from "./protocol.js";
import { visibleClaudeEvent } from "./transcript-claude.js";
import type { Entry } from "./transcripts.js";
import { withTranscriptIndex } from "./transcript-index.js";

/** Read raw provenance before public normalization removes private inputs. The
 * caller supplies only a path resolved for the verified conversation. Bounds
 * apply to lines and bytes; an unrelated latest user row is never a match. */
export async function claudeInputState(file: string, submitted?: string, executionId?: string): Promise<{
  input?: InputClassification; owner?: { at: string; text: string }; backgroundStop?: boolean; recovery: Entry[];
}> {
  return withTranscriptIndex(file, async (handle, index) => {
    let bytes = 0, input: InputClassification | undefined;
    let backgroundStop: boolean | undefined;
    const recovery: Entry[] = [];
    for await (const row of index.rows(handle, index.lines, Math.max(0, index.lines - 2048), undefined, 1_048_576)) {
      bytes += row.bytes?.length ?? 1_048_577;
      if (bytes > 1_048_576) break;
      let raw: Json;
      try { raw = object(JSON.parse(row.bytes!.toString())); } catch { continue; }
      if (["assistant", "system"].includes(String(raw.type))) {
        const visible = visibleClaudeEvent(raw);
        if (visible) recovery.push({ line: row.line, raw: visible });
      }
      const message = object(raw.message), attachment = object(raw.attachment);
      const content = message.content, blocks = objects(content);
      const text = typeof content === "string" ? content : blocks.filter(b => b.type === "text").map(b => String(b.text ?? "")).join("\n");
      // Only explicit execution provenance can mark a Stop as background.
      // Notification order and the presence/absence of reply text say nothing
      // about which execution stopped. A plain Stop remains a real boundary.
      if (executionId && backgroundStop === undefined && raw.type === "assistant" && (raw.executionId ?? raw.execution_id) === executionId) {
        backgroundStop = classifyClaudeInput({ text: "assistant", origin: raw.origin, isSidechain: raw.isSidechain }).category !== "owner";
      }
      const queued = raw.type === "attachment" && attachment.type === "queued_command";
      if (raw.type !== "user" && !queued) continue;
      const prompt = queued && typeof attachment.prompt === "string" ? attachment.prompt : text;
      const classification = classifyClaudeInput({ text: prompt, origin: raw.origin,
        commandMode: queued ? attachment.commandMode : raw.commandMode, notificationDelivery: queued,
        isMeta: raw.isMeta, isSidechain: raw.isSidechain, isCompactSummary: raw.isCompactSummary,
        toolResult: blocks.some(b => b.type === "tool_result"), hasImage: blocks.some(b => b.type === "image") });
      if (!input && submitted !== undefined && prompt === submitted) input = classification;
      if (raw.type === "user" && classification.category === "owner") {
        // An image-only or malformed latest owner boundary must not recover
        // an older textual prompt. Empty text deliberately leaves previews silent.
        const owner = typeof raw.timestamp === "string" && Number.isFinite(Date.parse(raw.timestamp))
          ? { at: raw.timestamp, text: prompt.slice(0, 65_536) } : undefined;
        return { input, owner, backgroundStop, recovery: recovery.reverse() };
      }
    }
    return { input, backgroundStop, recovery: [] };
  });
}
