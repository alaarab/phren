import { type Json } from "./protocol.js";
/** The sha git gives these bytes as a blob; GitHub reports the same one. */
export declare function blobSha(content: Buffer): string;
/** A tree sha for the store's current working tree, written through a private index. */
export declare function storeHead(store: string, indexFile?: string): Promise<{
    sha: string;
}>;
/** The recursive tree for a head, with the fields the phone's GitTree decodes. */
export declare function storeTree(store: string, sha: string): Promise<Json>;
export declare function storeBlob(store: string, sha: string): Promise<Json>;
/** Resolve a store-relative path, refusing escapes, .git and symlinked parents. */
export declare function storeFile(store: string, relative: string): Promise<string>;
/** Write one file if it still has the sha the phone last saw (null: must not exist). */
export declare function putStoreFile(store: string, data: Json): Promise<Json>;
export declare function deleteStoreFile(store: string, data: Json): Promise<Json>;
export declare const STORE_ROUTES: {
    readonly head: "/v1/store/head";
    readonly tree: "/v1/store/tree";
    readonly blob: "/v1/store/blob";
    readonly file: "/v1/store/file";
    readonly delete: "/v1/store/delete";
};
export declare function storeRoute(store: string, method: string, url: URL, data?: Json): Promise<Json>;
