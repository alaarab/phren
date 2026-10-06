import type { FindingType, PhrenResult } from "../shared.js";
import { type NoteItem } from "../data/notes.js";
export interface PromoteNoteResult {
    note: NoteItem;
    finding: string;
    message: string;
}
/** Copy a note into durable findings while retaining and marking its daily-note source. */
export declare function promoteNote(phrenPath: string, project: string, selector: string, findingType?: FindingType): PhrenResult<PromoteNoteResult>;
