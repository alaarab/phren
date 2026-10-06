import { type Json } from "./protocol.js";
export declare const tabActivityKey: (workspace: unknown, tab: unknown) => string;
/** A clock for Herdr's clockless state counters. Only successful snapshots
 * prune tabs; each activity pass also prunes missing servers. Writes are ordered
 * and atomic, and an unchanged poll never rewrites the file. */
export declare class TabActivityStore {
    private readonly file;
    private readonly now;
    private entries;
    private loaded;
    private dirty;
    private pending;
    constructor(file?: string, now?: () => Date);
    observe(server: string, snapshot: Json): Promise<ReadonlyMap<string, string>>;
    private load;
    private persist;
    pruneServers(servers: string[]): Promise<void>;
}
