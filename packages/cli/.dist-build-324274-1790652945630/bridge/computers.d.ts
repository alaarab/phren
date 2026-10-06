import { computerName } from "./protocol.js";
export { computerName };
export declare const dispatchKeyPath: (root?: string) => string;
export declare function publicComputerKey(value: string): string;
export declare function computerKeyLine(name: string, publicKey: string): string;
/** Never replace a dispatch identity implicitly: every peer enrolled this key. */
export declare function enrollComputer(name: string, root?: string): Promise<string>;
/** Accept a public key, rebuilding the restrictions rather than trusting supplied options. */
export declare function acceptComputer(name: string, input: string, sshDirectory?: string): Promise<void>;
/**
 * Append one authorized_keys line under a lock, refusing when `conflicts`
 * matches an existing line and leaving an identical line in place.
 */
export declare function appendAuthorizedKey(line: string, conflicts: (existing: string) => boolean, conflictMessage: string, sshDirectory?: string): Promise<void>;
