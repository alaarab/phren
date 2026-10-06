import { type ScreenRead } from "./terminal.js";
export interface PaneTextRequest extends ScreenRead {
    /** Names the read in the once-per-target warning; without it a failure is silent. */
    what?: string;
}
/** What a pane draws, or "" when the terminal cannot say. */
export declare function readPaneText(server: string, pane: string, request: PaneTextRequest): Promise<string>;
