import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

// Only terminal identity is supplied; the save resolves the pane's real repository.
const pane = vi.hoisted(() => ({ cwd: "", foreground_cwd: "" }));
vi.mock("./herdr.js", async original => ({ ...await original<object>(), validateTarget: async () => pane }));
import { readFileRange } from "./file-range.js";
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";

const exec = promisify(execFile);
let base: string | undefined;
afterEach(async () => { if (base) await rm(base, { recursive: true, force: true }); base = undefined; });
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
const save = (data: Record<string, unknown>) => paneRoute({} as PaneRouteContext,
  new URL("http://localhost/v1/files/write"), { target, ...data }, {} as ServerResponse);

it("saves into the pane's repository with the version it read, then refuses a stale one", async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "phren-file-write-")));
  const root = path.join(base, "repo");
  await exec("git", ["init", "-q", "-b", "main", root]);
  await exec("mkdir", ["-p", path.join(root, "src")]);
  await writeFile(path.join(root, "src/app.ts"), "let accent = green\n");
  pane.cwd = pane.foreground_cwd = path.join(root, "src"); // the agent is in a subfolder; saves are repository-relative

  const read = await readFileRange(root, "src/app.ts", 0, 1024);
  const saved = await save({ path: "src/app.ts", content: "let accent = purple\n", version: read.version }) as { version: string };
  expect(await readFile(path.join(root, "src/app.ts"), "utf8")).toBe("let accent = purple\n");
  await expect(save({ path: "src/app.ts", content: "again\n", version: saved.version })).resolves.toMatchObject({ created: false });
  await expect(save({ path: "src/app.ts", content: "stale\n", version: read.version }))
    .rejects.toMatchObject({ status: 409, details: { code: "file-changed" } });
  await expect(save({ path: "../outside.txt", content: "x" })).rejects.toMatchObject({ status: 400 });
  await expect(save({ path: "src/new.ts", content: "new\n" })).resolves.toMatchObject({ created: true });
  expect(await readFile(path.join(root, "src/app.ts"), "utf8")).toBe("again\n");
});

it("finds in files inside the pane's repository", async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "phren-file-search-")));
  const root = path.join(base, "repo");
  await exec("git", ["init", "-q", "-b", "main", root]);
  await writeFile(path.join(root, "a.ts"), "let accent = green\n");
  pane.cwd = pane.foreground_cwd = root;
  const find = (data: Record<string, unknown>) => paneRoute({} as PaneRouteContext,
    new URL("http://localhost/v1/files/search"), { target, ...data }, {} as ServerResponse);
  await expect(find({ query: "accent" })).resolves.toEqual({ matches: [{ file: "a.ts", lines: [{ line: 1, column: 5, text: "let accent = green" }] }], files: 1, total: 1, truncated: false });
  await expect(find({ query: "a", include: [":(top)x"] })).rejects.toThrow();
});
