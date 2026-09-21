import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteText } from "../phren-paths.js";
import { BUILTIN_MODULES } from "./registry.js";
import { moduleSnapshot } from "./runtime.js";

export function skillEnabled(store: string, name: string, profile?: string): boolean {
  const owner = BUILTIN_MODULES.find(module => module.skills.includes(name.replace(/\.md$/, "")));
  return !owner || moduleSnapshot(store, profile).has(owner.name);
}

export function reconcileStarterSkills(store: string, starter: string): void {
  const ledgerFile = path.join(store, ".runtime", "module-starters.json");
  let ledger: Record<string, string> = {};
  try { ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const snapshot = moduleSnapshot(store);
  for (const module of BUILTIN_MODULES) for (const skill of module.skills) {
    const source = path.join(starter, "global", "skills", skill);
    const visit = (dir: string, prefix: string): void => {
      if (!fs.existsSync(dir)) return;
      const destination = path.join(store, prefix);
      if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        const src = path.join(dir, entry.name), dest = path.join(store, relative);
        if (entry.isDirectory()) { visit(src, relative); continue; }
        if (!entry.isFile()) continue;
        const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) continue;
        const expected = digest(src);
        if (snapshot.has(module.name)) {
          if (!stat) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); ledger[relative] = expected; }
          else if (digest(dest) === expected) ledger[relative] = expected;
        } else if (stat && [expected, ledger[relative]].includes(digest(dest))) {
          fs.unlinkSync(dest); delete ledger[relative];
        }
      }
      const target = path.join(store, prefix);
      if (!snapshot.has(module.name) && fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    };
    visit(source, path.join("global", "skills", skill));
  }
  const instructions = path.join(starter, "global", "AGENTS.md");
  if (fs.existsSync(instructions)) {
    const relative = "global/AGENTS.md", dest = path.join(store, relative);
    const source = fs.readFileSync(instructions, "utf8"), desired = starterInstructions(store, source);
    const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (!stat || (stat.isFile() && !stat.isSymbolicLink() && [digest(instructions), ledger[relative]].includes(digest(dest)))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      atomicWriteText(dest, desired);
      ledger[relative] = digest(dest);
    }
  }
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  atomicWriteText(ledgerFile, JSON.stringify(ledger, null, 2) + "\n");
}

export function starterInstructions(store: string, content: string): string {
  if (moduleSnapshot(store).has("tasks")) return content;
  return content.split("\n").filter(line => !line.startsWith("- Tasks:")).join("\n")
    .replace("findings, tasks and skills", "findings and skills");
}
