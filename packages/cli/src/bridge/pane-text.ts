// The one reader of pane text. It sits beside herdr.ts rather than inside it so
// it calls Herdr through herdr.ts's exported rpc, the seam the bridge tests fake.
import { noteOptionalReadFailure, rpc } from "./herdr.js";
import { object, type Json } from "./protocol.js";

export interface PaneTextRequest {
  /** `agent.read` addresses the pane's agent; `pane.read` reads any pane,
   * including one whose agent is still starting. */
  method: "agent.read" | "pane.read";
  source: "visible" | "recent";
  lines: number;
  stripAnsi?: boolean;
  /** Herdr 0.9 answers plain text whatever `strip_ansi` says; "ansi" keeps the styles. */
  format?: "ansi";
  timeoutMs?: number;
  /** Names the read in the once-per-target warning; without it a failure is silent. */
  what?: string;
}

/** `pane.read` and `agent.read` both answer with a `read` object carrying the text. */
function readText(result: Json): string {
  const read = object(result.read ?? result);
  return typeof read.text === "string" ? read.text : "";
}

/** What a pane draws, or "" when Herdr cannot say: callers treat the text as optional. */
export async function readPaneText(server: string, pane: string, request: PaneTextRequest): Promise<string> {
  const params = { ...(request.method === "agent.read" ? { target: pane } : { pane_id: pane }),
    source: request.source, lines: request.lines, strip_ansi: request.stripAnsi ?? true,
    ...(request.format ? { format: request.format } : {}) };
  try {
    return readText(await rpc(server, request.method, params, undefined, request.timeoutMs));
  } catch (error) {
    if (request.what) noteOptionalReadFailure(request.what, `${server}/${pane}`, error);
    return "";
  }
}
