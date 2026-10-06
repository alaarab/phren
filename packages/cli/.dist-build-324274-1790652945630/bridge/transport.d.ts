import { type Json } from "./protocol.js";
/** Decode the base64url project folder from a `phren-hook v1 shell` command; undefined when it is not a path. */
export declare function decodeShellDirectory(encoded: string): string | undefined;
export declare function shellEnvironment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function health(): Promise<Json>;
/** The SSH key is forced to this allowlisted dispatcher. The supplied command is data, never a shell. */
export declare function dispatch(command: string): Promise<void>;
