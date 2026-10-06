import { type Json, type Provider } from "./protocol.js";
import { type LocalServer } from "./projects.js";
export interface SessionServer extends LocalServer {
    source: "started" | "mentioned";
}
export declare function mentionedPorts(text: string): Set<number>;
/** Whether `pid` is one of `roots` or descends from one. */
export declare function descendsFrom(pid: number | undefined, roots: ReadonlySet<number>, parents: ReadonlyMap<number, number>): boolean;
/** The ownership rule itself, free of I/O so it is tested directly. */
export declare function attributeServers(input: {
    servers: readonly LocalServer[];
    parents: ReadonlyMap<number, number>;
    ownRoots: ReadonlySet<number>;
    otherRoots: ReadonlySet<number>;
    mentioned: ReadonlySet<number>;
}): SessionServer[];
export declare function sessionWebServers(target: {
    server: string;
    pane: string;
    source: Provider;
    session: string;
}, pane: Json): Promise<{
    servers: SessionServer[];
}>;
