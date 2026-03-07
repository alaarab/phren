import { debugLog } from "./shared.js";
import type { SqlJsDatabase } from "./shared-index.js";

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

export function extractAndLinkEntities(db: SqlJsDatabase, content: string, sourceDoc: string): void {
  const entityNames = extractEntityNames(content);
  if (entityNames.length === 0) return;

  const docEntityId = getOrCreateEntity(db, sourceDoc, "document");
  if (docEntityId === -1) return;

  for (const name of entityNames) {
    const entityId = getOrCreateEntity(db, name, "library");
    if (entityId === -1) continue;
    try {
      db.run(
        "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
        [docEntityId, entityId, "mentions", sourceDoc]
      );
    } catch { /* ignore */ }
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
