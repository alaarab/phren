import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";

let temp: ReturnType<typeof makeTempDir> | undefined;
afterEach(() => { temp?.cleanup(); vi.doUnmock("./code-package.js"); vi.resetModules(); });

it("returns the installation hint when the optional package cannot be resolved", () => {
  temp = makeTempDir("optional-code-");
  const module = path.join(temp.path, "code-package.mjs");
  fs.copyFileSync(fileURLToPath(new URL("../../dist/modules/code-package.js", import.meta.url)), module);
  fs.writeFileSync(path.join(temp.path, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const script = `const code = await import(${JSON.stringify(pathToFileURL(module).href)});
    const messages = [];
    messages.push(await code.loadCodePackage() === undefined);
    for (const action of [code.requireCodePackage, code.installCodePackage]) {
      try { await action(); } catch (error) { messages.push(error.message); }
    }
    console.log(JSON.stringify(messages));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...process.env, PATH: `${temp.path}${path.delimiter}${process.env.PATH}` }, timeout: 10_000,
  });
  expect(JSON.parse(output)).toEqual([
    true, "phren code needs @phren/code: run phren modules enable code",
    "phren code needs @phren/code: run phren modules enable code\nInstallation failed. Run: npm install -g @phren/code",
  ]);
});

it("keeps the same actionable message at the Hook boundary", async () => {
  vi.resetModules();
  vi.doMock("./code-package.js", () => ({
    loadCodePackage: async () => undefined,
    CODE_PACKAGE_HINT: "phren code needs @phren/code: run phren modules enable code",
  }));
  const { CodeRoutes } = await import("../bridge/code-routes.js");
  await expect(new CodeRoutes("/missing-store").status("demo")).rejects.toMatchObject({
    status: 503, message: "phren code needs @phren/code: run phren modules enable code",
  });
});
