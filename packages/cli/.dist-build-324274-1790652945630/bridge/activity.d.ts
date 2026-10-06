import { type Json } from "./protocol.js";
/** Local bounded journal. No prompts, transcript bodies, credentials, or cloud upload. */
export declare class ActivityJournal {
    private pending;
    private previous;
    record(server: string, panes: Json[]): Promise<void>;
    recent(): Promise<Json[]>;
}
