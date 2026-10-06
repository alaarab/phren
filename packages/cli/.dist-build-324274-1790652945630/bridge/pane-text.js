// The one reader of pane text. It reads through the terminal provider and
// turns a failure into "": every caller treats the text as optional.
import { noteOptionalReadFailure } from "./herdr.js";
import { terminalProvider } from "./terminal.js";
/** What a pane draws, or "" when the terminal cannot say. */
export async function readPaneText(server, pane, request) {
    const { what, ...read } = request;
    try {
        return await terminalProvider().readScreen(server, pane, read);
    }
    catch (error) {
        if (what)
            noteOptionalReadFailure(what, `${server}/${pane}`, error);
        return "";
    }
}
