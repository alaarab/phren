import { getPhrenPath } from "./shared.js";
import { buildIndex, queryRows, queryFragmentLinks } from "./shared-index.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { errorMessage } from "./utils.js";

/**
 * CLI: phren graph [--project <name>] [--limit <n>]
 * Displays the fragment knowledge graph as a table.
 */
export async function handleGraphRead(args: string[]): Promise<void> {
  const phrenPath = getPhrenPath();
  const profile = resolveRuntimeProfile(phrenPath);

  let project: string | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--project" || args[i] === "-p") && args[i + 1]) {
      project = args[++i];
    } else if ((args[i] === "--limit" || args[i] === "-n") && args[i + 1]) {
      limit = Math.min(Math.max(parseInt(args[++i], 10) || 20, 1), 200);
    }
  }

  const db = await buildIndex(phrenPath, profile);

  let sql: string;
  let params: (string | number)[];

  if (project) {
    sql = `
      SELECT e.name, e.type, COUNT(el.source_id) as ref_count
      FROM entities e
      JOIN entity_links el ON el.target_id = e.id
      WHERE e.type != 'document' AND el.source_doc LIKE ?
      GROUP BY e.id, e.name, e.type
      ORDER BY ref_count DESC
      LIMIT ?
    `;
    params = [`${project}/%`, limit];
  } else {
    sql = `
      SELECT e.name, e.type, COUNT(el.source_id) as ref_count
      FROM entities e
      JOIN entity_links el ON el.target_id = e.id
      WHERE e.type != 'document'
      GROUP BY e.id, e.name, e.type
      ORDER BY ref_count DESC
      LIMIT ?
    `;
    params = [limit];
  }

  const rows = queryRows(db, sql, params);
  if (!rows || rows.length === 0) {
    console.log("No fragments in the knowledge graph.");
    return;
  }

  // Header
  const nameW = 30;
  const typeW = 12;
  const refW = 6;
  console.log(
    `${"Fragment".padEnd(nameW)} ${"Type".padEnd(typeW)} ${"Refs".padStart(refW)}`
  );
  console.log(`${"─".repeat(nameW)} ${"─".repeat(typeW)} ${"─".repeat(refW)}`);

  for (const row of rows) {
    const name = String(row[0]).slice(0, nameW);
    const type = String(row[1]).slice(0, typeW);
    const refs = String(Number(row[2]));
    console.log(`${name.padEnd(nameW)} ${type.padEnd(typeW)} ${refs.padStart(refW)}`);
  }

  console.log(`\n${rows.length} fragments shown.`);
}

/**
 * CLI: phren graph link <project> <finding_text> <fragment_name>
 * Links a finding to a fragment manually.
 */
export async function handleGraphLink(args: string[]): Promise<void> {
  if (args.length < 3) {
    console.error('Usage: phren graph link <project> "<finding text>" "<fragment name>"');
    process.exit(1);
  }

  const [project, findingText, fragmentName] = args;
  const phrenPath = getPhrenPath();
  const profile = resolveRuntimeProfile(phrenPath);

  const db = await buildIndex(phrenPath, profile);

  // Check that the finding exists
  const docCheck = queryRows(db, "SELECT content FROM docs WHERE project = ? AND filename = 'FINDINGS.md' LIMIT 1", [project]);
  if (!docCheck || docCheck.length === 0) {
    console.error(`No FINDINGS.md found for project "${project}".`);
    process.exit(1);
  }
  const content = String(docCheck[0][0]);
  if (!content.toLowerCase().includes(findingText.toLowerCase())) {
    console.error(`Finding text not found in ${project}/FINDINGS.md.`);
    process.exit(1);
  }

  // Use the MCP link_findings logic via direct DB operations
  const sourceDoc = `${project}/FINDINGS.md`;
  const normalizedFragment = fragmentName.toLowerCase();

  try {
    db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [normalizedFragment, "fragment", new Date().toISOString().slice(0, 10)]);
  } catch { /* best effort */ }

  const fragmentResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [normalizedFragment, "fragment"]);
  if (!fragmentResult?.length || !fragmentResult[0]?.values?.length) {
    console.error("Failed to create fragment.");
    process.exit(1);
  }
  const targetId = Number(fragmentResult[0].values[0][0]);

  try {
    db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [sourceDoc, "document", new Date().toISOString().slice(0, 10)]);
  } catch { /* best effort */ }

  const docResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [sourceDoc, "document"]);
  if (!docResult?.length || !docResult[0]?.values?.length) {
    console.error("Failed to create document fragment.");
    process.exit(1);
  }
  const sourceId = Number(docResult[0].values[0][0]);

  try {
    db.run(
      "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
      [sourceId, targetId, "mentions", sourceDoc],
    );
  } catch (err: unknown) {
    console.error(`Failed to link: ${errorMessage(err)}`);
    process.exit(1);
  }

  // Persist to manual-links.json
  const { runtimeFile } = await import("./shared.js");
  const fs = await import("fs");
  const crypto = await import("crypto");
  const { withFileLock } = await import("./shared-governance.js");

  const manualLinksPath = runtimeFile(phrenPath, "manual-links.json");
  try {
    withFileLock(manualLinksPath, () => {
      let existing: Array<{ entity: string; entityType: string; sourceDoc: string; relType: string }> = [];
      if (fs.existsSync(manualLinksPath)) {
        try { existing = JSON.parse(fs.readFileSync(manualLinksPath, "utf8")); } catch { /* fresh start */ }
      }
      const newEntry = { entity: normalizedFragment, entityType: "fragment", sourceDoc, relType: "mentions" };
      const alreadyStored = existing.some(
        (e) => e.entity === newEntry.entity && e.entityType === newEntry.entityType && e.sourceDoc === newEntry.sourceDoc && e.relType === newEntry.relType
      );
      if (!alreadyStored) {
        existing.push(newEntry);
        const tmpPath = manualLinksPath + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
        fs.renameSync(tmpPath, manualLinksPath);
      }
    });
  } catch (err: unknown) {
    console.error(`Failed to persist manual link: ${errorMessage(err)}`);
    process.exit(1);
  }

  console.log(`Linked "${fragmentName}" to ${sourceDoc}.`);
}

/**
 * CLI: phren graph <subcommand>
 * Routes graph subcommands.
 */
export async function handleGraphNamespace(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "link":
      return handleGraphLink(rest);
    case undefined:
    case "read":
      return handleGraphRead(rest);
    default:
      // Treat unknown subcommand as flags for read (e.g., --project)
      return handleGraphRead(args);
  }
}
