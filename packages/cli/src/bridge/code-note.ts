import * as path from "node:path";
import { z } from "zod";
import { addFindingToFile } from "../shared/content.js";
import { requireCodePackage } from "./code-routes.js";
import { BridgeError, sessionId, type Json } from "./protocol.js";
import { projectName } from "./dispatch.js";

export const codeNoteSchema = z.object({
  store: z.string().min(1).max(200).optional(),
  project: projectName,
  // The function, type or variable the note is about; `symbol` is the older
  // phone's spelling, accepted until 0.2.18.
  name: z.string().min(1).max(4600).optional(), symbol: z.string().min(1).max(4600).optional(),
  file: z.string().min(1).max(4096).refine(file => !path.isAbsolute(file) && !file.includes("\0") && !file.split(/[\\/]/).includes("..")),
  line: z.number().int().positive(), text: z.string().trim().min(1).max(4500).refine(text => !/[\x00-\x08\x0b-\x1f\x7f]/.test(text)),
  target: z.union([z.object({ session: sessionId }).strict(), z.object({ harness: z.enum(["codex", "claude", "opencode"]) }).strict()]).optional(),
}).strict();
export type CodeNote = z.infer<typeof codeNoteSchema>;
const noteName = (note: CodeNote): string => {
  const name = note.name ?? note.symbol;
  if (!name) throw new BridgeError(400, "Say which function, type or variable the note is about.");
  return name;
};
export type CodeNoteDelivery = (note: CodeNote, brief: string) => Promise<Json>;

export async function saveCodeNote(store: string, input: unknown, deliver?: CodeNoteDelivery): Promise<Json> {
  const note = codeNoteSchema.parse(input);
  if (note.target && !deliver) throw new BridgeError(409, "Enable conductor to send code notes to an agent.");
  const code = await requireCodePackage(store);
  const result = await code.definition(store, note.project, noteName(note));
  if (!result.available || !result.value) throw new BridgeError(404, "That function, type or variable is not in this project's code index.");
  const definition = result.value;
  const lastSnippetLine = definition.symbol.line + definition.snippet.split("\n").length - 1;
  if (definition.symbol.file !== note.file || note.line < definition.symbol.line || note.line > Math.min(definition.symbol.endLine, lastSnippetLine)) {
    throw new BridgeError(409, `The selected line is no longer part of ${noteName(note)}. Open it again.`);
  }
  const citation = { file: note.file, line: note.line, symbol: code.citationSymbolName(definition.symbol) };
  const saved = addFindingToFile(store, note.project, note.text, citation);
  if (!saved.ok) throw new BridgeError(400, saved.error);
  const brief = `${note.project}: ${citation.symbol}\n${note.file}:${note.line}\n\n${definition.snippet}\n\nNote:\n${note.text}`;
  let delivery: Json | undefined;
  if (note.target && deliver) {
    try { delivery = await deliver(note, brief); }
    catch (error) { delivery = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  }
  return { ok: true, saved: true, findings: code.findingsCitingSymbol(store, note.project, citation.symbol) as unknown as Json[], ...(delivery ? { delivery } : {}) };
}
