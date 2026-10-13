// Store trees and blobs are content-addressed, so one read serves every computer
// whose store holds the same sha: synced stores share almost every file.
import { hookGet } from "./api.js";

const MAX_ENTRIES = 400;
const trees = new Map(); // commit sha -> Promise<tree nodes>
const blobs = new Map(); // blob sha -> Promise<text>

/** Bytes of a base64 string decoded as UTF-8 text. */
export function decodeBase64(text) {
  const binary = atob(String(text || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** The cached promise for `key`, reading it once; a failed read is forgotten so the next call retries. */
export function cached(map, key, read) {
  const hit = map.get(key);
  if (hit) {
    // Refresh recency so the oldest unused entry is the one evicted.
    map.delete(key);
    map.set(key, hit);
    return hit;
  }
  const pending = read().catch((err) => {
    if (map.get(key) === pending) map.delete(key);
    throw err;
  });
  map.set(key, pending);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  return pending;
}

/** The store tree at a commit, read from `computer` unless another computer already read it. */
export function storeTree(computer, sha) {
  return cached(trees, sha, async () => {
    const listing = await hookGet(computer, "/v1/store/tree", { sha });
    return Array.isArray(listing.tree) ? listing.tree : [];
  });
}

/** A blob's text, read from `computer` unless another computer already read it. */
export function storeBlobText(computer, sha) {
  return cached(blobs, sha, async () => decodeBase64((await hookGet(computer, "/v1/store/blob", { sha })).content ?? ""));
}
