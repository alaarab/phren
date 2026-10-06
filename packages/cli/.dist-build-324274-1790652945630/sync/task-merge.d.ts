/**
 * Three-way merge of a tasks.md file by task id, for store sync conflicts.
 *
 * Each task is keyed by its `bid:` comment (or its normalized text when it has
 * none) and compared across the merge base, the local side and the incoming
 * side. The side that changed a task wins; when both changed it, a completed
 * side wins, then an edit beats a removal, then the incoming side wins. The
 * result keeps the incoming file's layout and section order.
 */
interface TaskEntry {
    key: string;
    section: string;
    lines: string[];
}
/** The winning version of one task, or undefined when it is removed. */
export declare function pickTask<T extends TaskEntry>(base: T | undefined, ours: T | undefined, theirs: T | undefined): T | undefined;
/**
 * Merges three versions of a tasks.md. `base` is empty when the file was
 * added on both sides.
 */
export declare function mergeTasksByBid(base: string, ours: string, theirs: string): string;
export {};
