import { debugLog } from "./shared.js";
import type { SqlJsDatabase } from "./shared-index.js";
import * as fs from "fs";

const ENTITY_PATTERNS = [
  // import/require patterns: import X from 'pkg' or require('pkg')
  /(?:import\s+.*?\s+from\s+['"])(@?[\w\-/]+)(?:['"])/g,
  /(?:require\s*\(\s*['"])(@?[\w\-/]+)(?:['"]\s*\))/g,
  // @scope/package patterns in text
  /@[\w-]+\/[\w-]+/g,
  // Known library/tool names mentioned in prose (case-insensitive word boundaries)
  /\b(React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Django|Flask|Rails|Spring|Redis|Postgres|PostgreSQL|MySQL|MongoDB|SQLite|Docker|Kubernetes|Terraform|AWS|GCP|Azure|Vercel|Netlify|Prisma|TypeORM|Sequelize|Jest|Vitest|Cypress|Playwright|Webpack|Vite|ESLint|Prettier|GraphQL|gRPC|Kafka|RabbitMQ|Elasticsearch|Nginx|Caddy|Node\.js|Deno|Bun|Python|Rust|Go|Java|TypeScript|Zod|Drizzle|tRPC|Tailwind|shadcn)\b/gi,
];

function extractEntityNames(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of ENTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1] || match[0];
      if (name && name.length > 1 && name.length < 100) {
        found.add(name.toLowerCase());
      }
    }
  }
  return [...found];
}

function getOrCreateEntity(db: SqlJsDatabase, name: string, type: string): number {
  try {
    db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [name, type]);
  } catch { /* ignore duplicate */ }
  const result = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [name, type]);
  if (result?.length && result[0]?.values?.length) {
    return Number(result[0].values[0][0]);
  }
  return -1;
}

/**
 * Ensure the global_entities cross-project index table exists.
 * Called during buildIndex to enable cross-project entity queries.
 */
export function ensureGlobalEntitiesTable(db: SqlJsDatabase): void {
  try {
    db.run(
      `CREATE TABLE IF NOT EXISTS global_entities (
        entity TEXT NOT NULL,
        project TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        PRIMARY KEY (entity, project, doc_key)
      )`
    );
  } catch { /* ignore if already exists */ }
}

/**
 * Parse user-defined entity names from CLAUDE.md frontmatter.
 * Looks for: <!-- cortex:entities: Redis,MyService,InternalAPI -->
 */
export function parseUserDefinedEntities(cortexPath: string, project: string): string[] {
  const claudeMdPath = `${cortexPath}/${project}/CLAUDE.md`;
  try {
    if (!fs.existsSync(claudeMdPath)) return [];
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    const match = content.match(/<!--\s*cortex:entities:\s*(.+?)\s*-->/);
    if (!match) return [];
    return match[1].split(",").map(s => s.trim()).filter(s => s.length > 0);
  } catch { return []; }
}

/**
 * Extract capitalized noun phrases (2+ words starting with uppercase) as candidate entities.
 * e.g. "Auth Service", "Data Pipeline", "Internal API"
 */
function extractCapitalizedPhrases(content: string): string[] {
  const found = new Set<string>();
  const pattern = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const phrase = match[1];
    // Filter out common false positives (sentence starts, etc.)
    if (phrase.length >= 4 && phrase.length < 60) {
      found.add(phrase.toLowerCase());
    }
  }
  return [...found];
}

export function extractAndLinkEntities(db: SqlJsDatabase, content: string, sourceDoc: string, cortexPath?: string): void {
  const entityNames = extractEntityNames(content);

  // Q28: Extract capitalized noun phrases as candidate entities
  const capitalizedPhrases = extractCapitalizedPhrases(content);
  for (const phrase of capitalizedPhrases) {
    entityNames.push(phrase);
  }

  // Q28: Add user-defined entities from CLAUDE.md frontmatter
  if (cortexPath) {
    const projectMatch = sourceDoc.match(/^([^/]+)\//);
    if (projectMatch) {
      const project = projectMatch[1];
      const userEntities = parseUserDefinedEntities(cortexPath, project);
      for (const ue of userEntities) {
        const lower = ue.toLowerCase();
        // Check if user-defined entity appears in content
        if (content.toLowerCase().includes(lower)) {
          entityNames.push(lower);
        }
      }
    }
  }

  // Deduplicate
  const uniqueNames = [...new Set(entityNames)];
  if (uniqueNames.length === 0) return;

  const docEntityId = getOrCreateEntity(db, sourceDoc, "document");
  if (docEntityId === -1) return;

  // Q20: Ensure global_entities table exists
  ensureGlobalEntitiesTable(db);

  // Extract project from sourceDoc for global_entities
  const projectMatch = sourceDoc.match(/^([^/]+)\//);
  const project = projectMatch ? projectMatch[1] : null;

  for (const name of uniqueNames) {
    const entityType = name.includes(" ") ? "concept" : "library";
    const entityId = getOrCreateEntity(db, name, entityType);
    if (entityId === -1) continue;
    try {
      db.run(
        "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
        [docEntityId, entityId, "mentions", sourceDoc]
      );
    } catch { /* ignore */ }

    // Q20: Write to global_entities for cross-project queries
    if (project) {
      try {
        db.run(
          "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
          [name, project, sourceDoc]
        );
      } catch { /* ignore */ }
    }
  }
}

/**
 * Query related entities for a given name.
 */
export function queryEntityLinks(db: SqlJsDatabase, name: string): { related: string[] } {
  const related: string[] = [];
  try {
    // Find the entity
    const entityResult = db.exec("SELECT id FROM entities WHERE name = ?", [name.toLowerCase()]);
    if (!entityResult?.length || !entityResult[0]?.values?.length) return { related };
    const entityId = Number(entityResult[0].values[0][0]);

    // Find related entities through links (both directions)
    const links = db.exec(
      `SELECT DISTINCT e.name FROM entity_links el JOIN entities e ON (el.target_id = e.id OR el.source_id = e.id)
       WHERE (el.source_id = ? OR el.target_id = ?) AND e.id != ?`,
      [entityId, entityId, entityId]
    );
    if (links?.length && links[0]?.values?.length) {
      for (const row of links[0].values) {
        related.push(String(row[0]));
      }
    }
  } catch { /* ignore query errors */ }
  return { related };
}

/**
 * Q20: Query cross-project entity relationships.
 * Returns projects and docs that share entities with the given query.
 */
export function queryCrossProjectEntities(
  db: SqlJsDatabase,
  entityName: string,
  excludeProject?: string
): Array<{ entity: string; project: string; docKey: string }> {
  const results: Array<{ entity: string; project: string; docKey: string }> = [];
  try {
    ensureGlobalEntitiesTable(db);
    const pattern = `%${entityName.toLowerCase()}%`;
    let sql = "SELECT entity, project, doc_key FROM global_entities WHERE entity LIKE ?";
    const params: (string | number)[] = [pattern];
    if (excludeProject) {
      sql += " AND project != ?";
      params.push(excludeProject);
    }
    sql += " ORDER BY entity LIMIT 50";
    const rows = db.exec(sql, params);
    if (rows?.length && rows[0]?.values?.length) {
      for (const row of rows[0].values) {
        results.push({
          entity: String(row[0]),
          project: String(row[1]),
          docKey: String(row[2]),
        });
      }
    }
  } catch { /* ignore query errors */ }
  return results;
}

export function getEntityBoostDocs(db: SqlJsDatabase, query: string, _cortexPath: string): Set<string> {
  const entityNames: string[] = [];
  try {
    const rows = db.exec("SELECT name FROM entities WHERE length(name) > 2")[0]?.values ?? [];
    for (const [name] of rows) {
      if (typeof name === 'string' && query.toLowerCase().includes(name.toLowerCase())) {
        entityNames.push(name);
      }
    }
  } catch { return new Set(); }

  const boostDocs = new Set<string>();
  for (const name of entityNames) {
    try {
      const rows = db.exec(
        "SELECT DISTINCT el.source_doc FROM entity_links el JOIN entities e ON el.target_id = e.id WHERE e.name = ? COLLATE NOCASE",
        [name]
      )[0]?.values ?? [];
      for (const [doc] of rows) {
        if (typeof doc === 'string') boostDocs.add(doc);
      }
    } catch { /* skip */ }
  }
  return boostDocs;
}
