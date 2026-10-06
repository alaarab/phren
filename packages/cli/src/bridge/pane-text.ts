// The one reader of pane text. It reads through the terminal provider and
// turns a failure into "": every caller treats the text as optional.
import { noteOptionalReadFailure } from "./herdr.js";
import { terminalProvider, type ScreenRead } from "./terminal.js";

export interface PaneTextRequest extends ScreenRead {
  /** Names the read in the once-per-target warning; without it a failure is silent. */
  what?: string;
}

/** What a pane draws, or "" when the terminal cannot say. */
export async function readPaneText(server: string, pane: string, request: PaneTextRequest): Promise<string> {
  const { what, ...read } = request;
  try {
    return await terminalProvider().readScreen(server, pane, read);
  } catch (error) {
    if (what) noteOptionalReadFailure(what, `${server}/${pane}`, error);
    return "";
  }
}
