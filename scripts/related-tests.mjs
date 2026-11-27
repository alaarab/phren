#!/usr/bin/env node
// Prints the test files that import one of the given source files directly,
// plus each source file's own `<name>.test.ts`. PR CI runs these on Linux so a
// source change that breaks an existing test fails on the PR, not in the RC.
//
// `vitest related` follows imports transitively; a change under bridge/
// selected 404 of 684 test files (6.5 minutes on 4 cores) for #935 and
// #936. One hop keeps the run short and still catches the tests that
// exercise the changed module (the two RC 45925229497 failures both import
// data/tasks.ts, which #936 changed).
//
// Usage: node scripts/related-tests.mjs <source files...>  (repo-relative)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoots = [
  "packages/cli/src",
  "packages/code/src",
  "packages/desktop/src",
  "packages/desktop-kit/src",
  "packages/push-relay/src",
  "packages/vscode/test",
];

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// A specifier's extension says .js while the source is .ts; compare without it.
const stem = (file) => file.replace(/\.(ts|tsx|mts|js|mjs|jsx)$/, "").replace(/\/index$/, "");

const changed = new Set(
  process.argv
    .slice(2)
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map((file) => stem(resolve(root, file))),
);
if (changed.size === 0) process.exit(0);

const specifier = /(?:from|import|vi\.mock|vi\.importActual|vi\.doMock)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
const selected = [];
for (const testRoot of testRoots) {
  const abs = join(root, testRoot);
  if (!existsSync(abs)) continue;
  for (const test of walk(abs, [])) {
    if (changed.has(stem(test.replace(/\.test(\.tsx?)$/, "$1")))) {
      selected.push(test);
      continue;
    }
    const text = readFileSync(test, "utf8");
    for (const match of text.matchAll(specifier)) {
      if (changed.has(stem(resolve(dirname(test), match[1])))) {
        selected.push(test);
        break;
      }
    }
  }
}
for (const test of selected.sort()) console.log(relative(root, test));
