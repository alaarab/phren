export declare function machineFilePath(): string;
export declare function defaultMachineName(): string;
export declare function getMachineName(): string;
/** A store commit's subject with this machine's name, so `git log` on a synced
 *  store shows which computer wrote each change. */
export declare function storeCommitMessage(message: string): string;
export declare function persistMachineName(machine: string): void;
export declare function getCurrentActor(): string;
