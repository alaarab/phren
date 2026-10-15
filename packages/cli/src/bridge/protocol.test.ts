import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async original => ({ ...await original<object>(), writeFile: vi.fn() }));
import { atomic } from "./protocol.js";

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

it("removes a partially written private temp file when writing fails and preserves the old credential file", async () => {
  const real = await vi.importActual<typeof fs>("node:fs/promises");
  await fs.mkdir(".scratch", { recursive: true });
  directory = await fs.mkdtemp(path.resolve(".scratch/atomic-failure-"));
  const file = path.join(directory, "git-hosts.json");
  await real.writeFile(file, "previous credentials", { mode: 0o600 });
  let partial = "";
  vi.mocked(fs.writeFile).mockImplementationOnce(async (temporary, _data, options) => {
    partial = String(temporary);
    // Simulate writeFile creating the file, writing plaintext, then hitting ENOSPC.
    await real.writeFile(temporary, "plaintext-token-prefix", options);
    if (process.platform !== "win32") expect((await fs.stat(temporary)).mode & 0o777).toBe(0o600);
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  await expect(atomic(file, "plaintext-token")).rejects.toMatchObject({ code: "ENOSPC" });
  expect(partial).not.toBe("");
  expect(await fs.readdir(directory)).toEqual(["git-hosts.json"]);
  expect(await fs.readFile(file, "utf8")).toBe("previous credentials");
});
