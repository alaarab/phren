import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "wc-lite-"));
const file = join(dir, "a.txt");
writeFileSync(file, "one two\nthree\n");

function run(args) {
  let output = "";
  const code = main(args, (s) => { output += s; });
  return { code, output };
}

test("plain output is unchanged", () => {
  assert.deepEqual(run([file]), { code: 0, output: `2 3 14 ${file}\n` });
});

test("--json prints one JSON object with the counts and file", () => {
  const { code, output } = run(["--json", file]);
  assert.equal(code, 0);
  assert.ok(output.endsWith("\n"));
  assert.deepEqual(JSON.parse(output), { file, lines: 2, words: 3, chars: 14 });
});

test("--json works after the file too", () => {
  assert.deepEqual(JSON.parse(run([file, "--json"]).output).words, 3);
});

test("unknown flags are rejected with exit code 2", () => {
  const { code, output } = run(["--bogus", file]);
  assert.equal(code, 2);
  assert.match(output, /unknown option: --bogus/);
});
