import * as path from "node:path";
import { resolveAllStores, registeredStoreIdentity, getStoreProjectDirs } from "../store-registry.js";
import { storeRepositoryIdentity } from "./memory-store.js";


function directoryStores(base: string) {
  return resolveAllStores(base, { migrateAttachments: false }).map(store => ({ ...store,
    storeId: store.available === false ? undefined : registeredStoreIdentity(store.path),
  }));
}

function storeProjects(store: ReturnType<typeof directoryStores>[number]): string[] {
  if (store.available === false) return [];
  try {
    return getStoreProjectDirs(store).map(dir => path.basename(dir))
      .filter(project => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(project)).sort();
  } catch { return []; }
}

/** The portable store identities used by remote clients to request a pull. */
export async function storeDirectory(base: string) {
  const stores = directoryStores(base);
  return { ok: true, version: 1, stores: await Promise.all(stores.map(async store => {
    const available = store.available !== false;
    const ambiguous = !!store.storeId && stores.filter(entry => entry.storeId === store.storeId).length > 1;
    const repositoryIdentity = available && !ambiguous ? await storeRepositoryIdentity(store.path) : undefined;
    return {
      id: store.storeId ?? null, name: store.name, role: store.role, primary: store.role === "primary", available,
      // Older phones decode these fields before resolving the store for finding freshness.
      identityReady: !!store.storeId && !ambiguous, ambiguous, metadataWritable: false,
      ...(repositoryIdentity ? { repositoryIdentity } : {}),
      projects: storeProjects(store),
    };
  })) };
}
