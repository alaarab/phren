import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import {
  readStoreRegistry,
  writeStoreRegistry,
  resolveAllStores,
  getPrimaryStore,
  getReadableStores,
  getNonPrimaryStores,
  findStoreByName,
  addStoreToRegistry,
  removeStoreFromRegistry,
  generateStoreId,
  readTeamBootstrap,
  storesFilePath,
  type StoreRegistry,
  type StoreEntry,
} from "./store-registry.js";

describe("store-registry", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenDir: string;
  const origFedPaths = process.env.PHREN_FEDERATION_PATHS;

  beforeEach(() => {
    tmp = makeTempDir("store-registry-test-");
    phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });
    delete process.env.PHREN_FEDERATION_PATHS;
  });

  afterEach(() => {
    if (origFedPaths !== undefined) {
      process.env.PHREN_FEDERATION_PATHS = origFedPaths;
    } else {
      delete process.env.PHREN_FEDERATION_PATHS;
    }
    tmp.cleanup();
  });

  // ── generateStoreId ──────────────────────────────────────────────────────

  describe("generateStoreId", () => {
    it("returns 8-char hex string", () => {
      const id = generateStoreId();
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateStoreId()));
      expect(ids.size).toBe(50);
    });
  });

  // ── readStoreRegistry ────────────────────────────────────────────────────

  describe("readStoreRegistry", () => {
    it("returns null when stores.yaml does not exist", () => {
      expect(readStoreRegistry(phrenDir)).toBeNull();
    });

    it("returns null for invalid YAML", () => {
      fs.writeFileSync(storesFilePath(phrenDir), "not: valid: yaml: [");
      expect(readStoreRegistry(phrenDir)).toBeNull();
    });

    it("returns null for wrong version", () => {
      fs.writeFileSync(storesFilePath(phrenDir), "version: 2\nstores: []\n");
      expect(readStoreRegistry(phrenDir)).toBeNull();
    });

    it("returns null for missing stores array", () => {
      fs.writeFileSync(storesFilePath(phrenDir), "version: 1\n");
      expect(readStoreRegistry(phrenDir)).toBeNull();
    });

    it("parses a valid registry", () => {
      // Use forward slashes in YAML paths to avoid Windows backslash escaping issues
      const teamDir = path.join(tmp.path, "team");
      const yaml = `version: 1
stores:
  - id: "abc12345"
    name: personal
    path: "${phrenDir.replace(/\\/g, "/")}"
    role: primary
    sync: managed-git
  - id: "def67890"
    name: team-arc
    path: "${teamDir.replace(/\\/g, "/")}"
    role: team
    sync: managed-git
    remote: "git@github.com:test/repo.git"
    projects:
      - arc
      - arc-api
`;
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(storesFilePath(phrenDir), yaml);

      const registry = readStoreRegistry(phrenDir);
      expect(registry).not.toBeNull();
      expect(registry!.version).toBe(1);
      expect(registry!.stores).toHaveLength(2);
      expect(registry!.stores[0].name).toBe("personal");
      expect(registry!.stores[0].role).toBe("primary");
      expect(registry!.stores[1].name).toBe("team-arc");
      expect(registry!.stores[1].remote).toBe("git@github.com:test/repo.git");
      expect(registry!.stores[1].projects).toEqual(["arc", "arc-api"]);
    });

    it("returns null when a store entry is missing required fields", () => {
      const yaml = `version: 1
stores:
  - name: personal
    path: "${phrenDir}"
    role: primary
    sync: managed-git
`;
      fs.writeFileSync(storesFilePath(phrenDir), yaml);
      // Missing id → normalizeRegistry returns null
      expect(readStoreRegistry(phrenDir)).toBeNull();
    });
  });

  // ── writeStoreRegistry ───────────────────────────────────────────────────

  describe("writeStoreRegistry", () => {
    it("round-trips a registry", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "team", path: path.join(tmp.path, "team"), role: "team", sync: "managed-git", remote: "git@gh.com:t.git" },
        ],
      };

      writeStoreRegistry(phrenDir, registry);
      const loaded = readStoreRegistry(phrenDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.stores).toHaveLength(2);
      expect(loaded!.stores[0].id).toBe("aaa11111");
      expect(loaded!.stores[1].remote).toBe("git@gh.com:t.git");
    });

    it("rejects registry with no primary store", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "team", path: phrenDir, role: "team", sync: "managed-git" },
        ],
      };
      expect(() => writeStoreRegistry(phrenDir, registry)).toThrow(/exactly one primary/);
    });

    it("rejects registry with duplicate names", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "same", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "same", path: path.join(tmp.path, "x"), role: "team", sync: "managed-git" },
        ],
      };
      expect(() => writeStoreRegistry(phrenDir, registry)).toThrow(/Duplicate store name/);
    });

    it("rejects registry with duplicate IDs", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "a", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "aaa11111", name: "b", path: path.join(tmp.path, "x"), role: "team", sync: "managed-git" },
        ],
      };
      expect(() => writeStoreRegistry(phrenDir, registry)).toThrow(/Duplicate store id/);
    });

    it("rejects invalid role", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "a", path: phrenDir, role: "admin" as any, sync: "managed-git" },
        ],
      };
      expect(() => writeStoreRegistry(phrenDir, registry)).toThrow(/invalid role/);
    });
  });

  // ── resolveAllStores ─────────────────────────────────────────────────────

  describe("resolveAllStores", () => {
    it("returns implicit primary when no stores.yaml exists", () => {
      const stores = resolveAllStores(phrenDir);
      expect(stores).toHaveLength(1);
      expect(stores[0].role).toBe("primary");
      expect(stores[0].name).toBe("personal");
      expect(stores[0].path).toBe(phrenDir);
    });

    it("returns registry stores when stores.yaml exists", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      const stores = resolveAllStores(phrenDir);
      expect(stores).toHaveLength(1);
      expect(stores[0].id).toBe("aaa11111");
    });

    it("appends PHREN_FEDERATION_PATHS entries as readonly stores", () => {
      const fedStore = path.join(tmp.path, "fed-store");
      fs.mkdirSync(fedStore, { recursive: true });
      process.env.PHREN_FEDERATION_PATHS = fedStore;

      const stores = resolveAllStores(phrenDir);
      expect(stores).toHaveLength(2);
      expect(stores[1].role).toBe("readonly");
      expect(stores[1].sync).toBe("pull-only");
      expect(stores[1].path).toBe(fedStore);
    });

    it("does not duplicate federation paths already in registry", () => {
      const fedStore = path.join(tmp.path, "fed-store");
      fs.mkdirSync(fedStore, { recursive: true });

      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "fed", path: fedStore, role: "readonly", sync: "pull-only" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);
      process.env.PHREN_FEDERATION_PATHS = fedStore;

      const stores = resolveAllStores(phrenDir);
      expect(stores).toHaveLength(2); // not 3
    });

    it("skips non-existent federation paths", () => {
      process.env.PHREN_FEDERATION_PATHS = "/nonexistent/path/that/does/not/exist";
      const stores = resolveAllStores(phrenDir);
      expect(stores).toHaveLength(1); // just implicit primary
    });
  });

  // ── getPrimaryStore / getReadableStores / getNonPrimaryStores ────────────

  describe("store accessors", () => {
    it("getPrimaryStore returns the primary entry", () => {
      const primary = getPrimaryStore(phrenDir);
      expect(primary.role).toBe("primary");
      expect(primary.path).toBe(phrenDir);
    });

    it("getReadableStores returns all stores", () => {
      const fedStore = path.join(tmp.path, "fed");
      fs.mkdirSync(fedStore, { recursive: true });
      process.env.PHREN_FEDERATION_PATHS = fedStore;

      const readable = getReadableStores(phrenDir);
      expect(readable).toHaveLength(2);
    });

    it("getNonPrimaryStores excludes primary", () => {
      const fedStore = path.join(tmp.path, "fed");
      fs.mkdirSync(fedStore, { recursive: true });
      process.env.PHREN_FEDERATION_PATHS = fedStore;

      const nonPrimary = getNonPrimaryStores(phrenDir);
      expect(nonPrimary).toHaveLength(1);
      expect(nonPrimary[0].role).toBe("readonly");
    });
  });

  // ── findStoreByName ──────────────────────────────────────────────────────

  describe("findStoreByName", () => {
    it("finds by name", () => {
      const store = findStoreByName(phrenDir, "personal");
      expect(store).toBeDefined();
      expect(store!.role).toBe("primary");
    });

    it("returns undefined for unknown name", () => {
      expect(findStoreByName(phrenDir, "nonexistent")).toBeUndefined();
    });
  });

  // ── addStoreToRegistry / removeStoreFromRegistry ─────────────────────────

  describe("addStoreToRegistry", () => {
    it("creates stores.yaml with implicit primary + new entry", () => {
      const entry: StoreEntry = {
        id: "ccc33333",
        name: "team-arc",
        path: path.join(tmp.path, "team"),
        role: "team",
        sync: "managed-git",
        remote: "git@gh.com:team.git",
      };

      addStoreToRegistry(phrenDir, entry);

      const registry = readStoreRegistry(phrenDir);
      expect(registry).not.toBeNull();
      expect(registry!.stores).toHaveLength(2);
      expect(registry!.stores[0].role).toBe("primary");
      expect(registry!.stores[1].name).toBe("team-arc");
    });

    it("appends to existing registry", () => {
      const initial: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, initial);

      addStoreToRegistry(phrenDir, {
        id: "ddd44444", name: "company", path: path.join(tmp.path, "co"),
        role: "readonly", sync: "pull-only",
      });

      const registry = readStoreRegistry(phrenDir);
      expect(registry!.stores).toHaveLength(2);
    });

    it("rejects duplicate name", () => {
      addStoreToRegistry(phrenDir, {
        id: "eee55555", name: "team", path: path.join(tmp.path, "t1"),
        role: "team", sync: "managed-git",
      });
      expect(() => addStoreToRegistry(phrenDir, {
        id: "fff66666", name: "team", path: path.join(tmp.path, "t2"),
        role: "team", sync: "managed-git",
      })).toThrow(/already exists/);
    });
  });

  describe("removeStoreFromRegistry", () => {
    it("removes a non-primary store", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "team", path: path.join(tmp.path, "team"), role: "team", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      const removed = removeStoreFromRegistry(phrenDir, "team");
      expect(removed.name).toBe("team");

      const updated = readStoreRegistry(phrenDir);
      expect(updated!.stores).toHaveLength(1);
    });

    it("refuses to remove primary store", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      expect(() => removeStoreFromRegistry(phrenDir, "personal")).toThrow(/Cannot remove the primary/);
    });

    it("throws for unknown store name", () => {
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      expect(() => removeStoreFromRegistry(phrenDir, "nope")).toThrow(/not found/);
    });

    it("throws when no stores.yaml exists", () => {
      expect(() => removeStoreFromRegistry(phrenDir, "team")).toThrow(/No stores.yaml/);
    });
  });

  // ── readTeamBootstrap ────────────────────────────────────────────────────

  describe("readTeamBootstrap", () => {
    it("returns null when .phren-team.yaml does not exist", () => {
      expect(readTeamBootstrap(phrenDir)).toBeNull();
    });

    it("reads a valid bootstrap file", () => {
      fs.writeFileSync(path.join(phrenDir, ".phren-team.yaml"), "name: arc-team\ndescription: Arc platform team\ndefault_role: team\n");
      const bootstrap = readTeamBootstrap(phrenDir);
      expect(bootstrap).not.toBeNull();
      expect(bootstrap!.name).toBe("arc-team");
      expect(bootstrap!.description).toBe("Arc platform team");
      expect(bootstrap!.default_role).toBe("team");
    });

    it("returns null for invalid YAML", () => {
      fs.writeFileSync(path.join(phrenDir, ".phren-team.yaml"), "bad: yaml: [");
      expect(readTeamBootstrap(phrenDir)).toBeNull();
    });

    it("returns null when name is missing", () => {
      fs.writeFileSync(path.join(phrenDir, ".phren-team.yaml"), "description: no name\n");
      expect(readTeamBootstrap(phrenDir)).toBeNull();
    });
  });
});
