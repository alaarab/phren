// CONTRACT STUB — worker C owns dream/pages.ts and dream/budget.ts. These stand in
// for them so the engine compiles on its own branch. At integration, delete this
// file and point the imports in collect.ts / apply.ts / run.ts at ./pages.js and
// ./budget.js. Signatures follow the v1 contract (section 5).
import * as fs from "fs";
import * as path from "path";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

// CONTRACT STUB: writePage(store, project, slug, markdown, links) from ./pages.ts
export async function writePage(store: string, project: string, slug: string, markdown: string, links: string[]): Promise<{ path: string; brokenLinks: string[] }> {
  if (!SLUG.test(slug)) throw new Error(`Invalid page slug: "${slug}"`);
  const dir = path.join(store, project, "reference", "pages");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  const brokenLinks = links.filter(link => !fs.existsSync(path.join(dir, `${link}.md`)));
  return { path: file, brokenLinks };
}

// CONTRACT STUB: injectedSize(store, project) from ./budget.ts — bytes Phren injects at session start.
export async function injectedSize(store: string, project: string): Promise<number> {
  try { return fs.statSync(path.join(store, project, "truths.md")).size; } catch { return 0; }
}

// CONTRACT STUB: overBudget(store, project, budgetKB) from ./budget.ts — demotion candidates
// (truth texts), least recently cited first; empty when within budget.
export async function overBudget(store: string, project: string, budgetKB: number): Promise<string[]> {
  if (await injectedSize(store, project) <= budgetKB * 1024) return [];
  try {
    return fs.readFileSync(path.join(store, project, "truths.md"), "utf8").split("\n")
      .filter(line => line.startsWith("- ")).map(line => line.slice(2).replace(/\s*_\(added \d{4}-\d{2}-\d{2}\)_\s*$/, "").trim());
  } catch { return []; }
}
