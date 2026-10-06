import { type FileHandle } from "node:fs/promises";
/** A sparse byte/line index, shared by live readers, history pages, and images.
 * Indexing counts newlines without decoding JSON or retaining transcript text.
 * At the 4 GiB file limit, checkpoints occupy only a few hundred KiB. */
declare class TranscriptIndex {
    readonly file: string;
    revision: `${string}-${string}-${string}-${string}-${string}`;
    lines: number;
    private identity;
    private modified;
    private scanned;
    private complete;
    private checkpoints;
    private tail;
    constructor(file: string);
    use<T>(read: (handle: FileHandle, index: TranscriptIndex) => Promise<T>, signal?: AbortSignal): Promise<T>;
    private refresh;
    private position;
    /** Read newest first and stop as soon as the caller has a page. Large rows
     * are skipped with bounded memory while keeping absolute line identities. */
    rows(handle: FileHandle, before: number, after: number, signal?: AbortSignal): AsyncGenerator<{
        line: number;
        bytes?: Buffer;
    }>;
}
export declare function withTranscriptIndex<T>(file: string, read: (handle: FileHandle, index: TranscriptIndex) => Promise<T>, signal?: AbortSignal): Promise<T>;
export {};
