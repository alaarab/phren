import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexExecutable, phrenWrapperTarget } from "./codex-binary.js";
import { shellEscape } from "../hooks.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-codex-binary-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** The head of the wrapper `phren init` writes (hooks.ts installSessionWrapper). */
const wrapper = (real: string) => `#!/bin/sh
set -u

REAL_BIN=${shellEscape(real)}
DEFAULT_PHREN_PATH='/home/me/.phren'
export PHREN_HOOK_TOOL="codex"

if [ ! -x "$REAL_BIN" ]; then
  echo "phren wrapper error: real codex binary not executable: $REAL_BIN" >&2
  exit 127
fi
`;
async function file(directory: string, content: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "codex"), content, { mode: 0o755 });
  return path.join(directory, "codex");
}

it("reads the real binary a phren wrapper names, quotes included, and ignores other scripts", async () => {
  const wrapped = await file(path.join(root, "a"), wrapper("/opt/it's here/codex"));
  expect(phrenWrapperTarget(wrapped)).toBe("/opt/it's here/codex");
  expect(phrenWrapperTarget(await file(path.join(root, "b"), "#!/bin/sh\nexec /usr/bin/true\n"))).toBeUndefined();
  expect(phrenWrapperTarget(path.join(root, "missing"))).toBeUndefined();
});

// Executable-bit lookups on PATH; the Hook resolves plain "codex" on Windows.
it.skipIf(process.platform === "win32")("skips phren's wrapper on PATH and falls through when its target is gone", async () => {
  const real = await file(path.join(root, "real"), "#!/bin/sh\n");
  await file(path.join(root, "wrap"), wrapper(real));
  await file(path.join(root, "stale"), wrapper(path.join(root, "gone", "codex")));
  const other = await file(path.join(root, "other"), "#!/bin/sh\n");
  const PATH = (...dirs: string[]) => ({ PATH: dirs.map(d => path.join(root, d)).join(path.delimiter) });
  expect(codexExecutable(PATH("wrap", "other"))).toBe(real);
  expect(codexExecutable(PATH("stale", "other"))).toBe(other);
  expect(codexExecutable(PATH("other", "wrap"))).toBe(other);
  expect(codexExecutable({ PATH: "relative/bin" })).toBe("codex");
});
