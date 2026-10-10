import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Each section's stylesheet loads globally the first time the section opens, so
// a section's root class (".review { position: absolute; inset: 0 }") restyles
// any other element that carries the same word as a modifier. Memory's
// "mem-count review" badge grew to the whole window once Review had been seen.

const UI = join(__dirname, "..", "ui");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "editor-host" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}

describe("section root classes", () => {
  it("are never reused as a modifier on another element", () => {
    const roots = new Set<string>();
    for (const css of files(join(UI, "sections")).filter((f) => f.endsWith(".css"))) {
      // Layout roots only; a colour-only helper like ".muted" is harmless to share.
      for (const m of readFileSync(css, "utf8").matchAll(/^\.([a-z]+)\s*\{([^}]*)\}/gm)) {
        if (/\b(position|display|inset|width|height)\s*:/.test(m[2])) roots.add(m[1]);
      }
    }
    expect(roots.size).toBeGreaterThan(3);
    const clashes: string[] = [];
    for (const js of files(UI).filter((f) => f.endsWith(".js"))) {
      for (const m of readFileSync(js, "utf8").matchAll(/["`]([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)+)["`]/g)) {
        const [, ...rest] = m[1].split(" ");
        for (const word of rest) if (roots.has(word)) clashes.push(`${js.slice(UI.length + 1)}: "${m[1]}"`);
      }
    }
    expect(clashes).toEqual([]);
  });
});
