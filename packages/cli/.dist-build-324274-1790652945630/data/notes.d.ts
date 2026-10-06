import { type PhrenResult } from "../shared.js";
export declare const NOTES_DIRNAME = "notes";
export declare const MAX_NOTE_LENGTH = 10000;
export interface NoteItem {
    id: string;
    stableId: string;
    project: string;
    date: string;
    time: string;
    text: string;
    promoted: boolean;
    path: string;
}
export interface ListNotesOptions {
    date?: string;
    limit?: number;
}
export interface AddNoteOptions {
    date?: string;
    now?: Date;
}
export declare function noteFilePath(phrenPath: string, project: string, date: string): PhrenResult<string>;
export declare function listNotes(phrenPath: string, project: string, options?: ListNotesOptions): PhrenResult<NoteItem[]>;
export declare function getNote(phrenPath: string, project: string, selector: string): PhrenResult<NoteItem>;
export declare function addNote(phrenPath: string, project: string, text: string, options?: AddNoteOptions): PhrenResult<NoteItem>;
export declare function editNote(phrenPath: string, project: string, selector: string, text: string): PhrenResult<NoteItem>;
export declare function removeNote(phrenPath: string, project: string, selector: string): PhrenResult<NoteItem>;
export declare function markNotePromoted(phrenPath: string, project: string, selector: string): PhrenResult<NoteItem>;
