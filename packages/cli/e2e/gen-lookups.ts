/*
 * Authentic lookup generator for the big-store e2e. Builds the FTS index for a
 * store and drives the *real* search_knowledge MCP handler (same path the agent
 * uses), so .runtime/lookup-events.jsonl is populated with genuine events —
 * including real finding nodeIds. Run via tsx:
 *
 *   tsx gen-lookups.ts <storePath> all
 *   tsx gen-lookups.ts <storePath> one <queryIndex>
 */
import { buildIndex } from "../src/shared/index.js";
import { register } from "../src/tools/search.js";
import { BIG_STORE_QUERIES } from "./big-store-fixture.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

async function main(): Promise<void> {
  const storePath = process.argv[2];
  const mode = process.argv[3] ?? "all";
  if (!storePath) throw new Error("usage: gen-lookups <storePath> <all|one> [index]");

  const db = await buildIndex(storePath);
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
  };
  register(server as never, {
    phrenPath: storePath,
    profile: "work",
    db: () => db,
    rebuildIndex: async () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  } as never);

  const search = tools.get("search_knowledge");
  if (!search) throw new Error("search_knowledge not registered");

  const queries =
    mode === "one"
      ? [BIG_STORE_QUERIES[Number(process.argv[4] ?? 0) % BIG_STORE_QUERIES.length]]
      : BIG_STORE_QUERIES;

  let hits = 0;
  for (const query of queries) {
    const res = await search({ query, limit: 6 });
    const parsed = JSON.parse(res.content[0].text);
    if (parsed.ok && parsed.data?.results?.length) hits += parsed.data.results.length;
  }
  process.stdout.write(`gen-lookups: ran ${queries.length} queries, ${hits} hits\n`);
  db.close();
}

main().catch((err) => {
  process.stderr.write(`gen-lookups failed: ${err?.stack || err}\n`);
  process.exit(1);
});
