import { type StoreEntry } from "../store-registry.js";
export type ConfirmStoreRemoval = (message: string) => Promise<boolean>;
/** Only the interactive CLI supplies confirmation; hooks and MCP never remove stores. */
export declare function storeCredentialCheck(phrenPath: string, store: StoreEntry, fix: boolean, confirm?: ConfirmStoreRemoval, now?: number): Promise<{
    name: string;
    ok: boolean;
    detail: string;
} | undefined>;
