#!/usr/bin/env node
// wc-lite: count lines, words and characters of a file.
import { readFileSync } from "node:fs";

export function count(text) {
  const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const words = text.split(/\s+/).filter(Boolean).length;
  return { lines, words, chars: text.length };
}

export function main(argv, out = (s) => process.stdout.write(s)) {
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length !== 1) {
    out("usage: wc-lite <file>\n");
    return 2;
  }
  const c = count(readFileSync(files[0], "utf8"));
  out(`${c.lines} ${c.words} ${c.chars} ${files[0]}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
