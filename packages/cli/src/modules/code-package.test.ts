import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";

const temps: Array<ReturnType<typeof makeTempDir>> = [];
function tempDir(prefix: string): string {
  const temp = makeTempDir(prefix);
  temps.push(temp);
  return temp.path;
}
afterEach(() => {
  for (const temp of temps.splice(0)) temp.cleanup();
  vi.doUnmock("./code-package.js");
  vi.resetModules();
});

const moduleSource = fileURLToPath(new URL("../../dist/modules/code-package.js", import.meta.url));

/** A fake @phren/code that exports a distinct marker from its entry point. */
function writePackage(directory: string, marker: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "@phren/code", type: "module", exports: { ".": "./index.mjs" } }));
  fs.writeFileSync(path.join(directory, "index.mjs"), `export const marker = ${JSON.stringify(marker)};\n`);
}

function copyModule(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const module = path.join(directory, "code-package.mjs");
  fs.copyFileSync(moduleSource, module);
  return module;
}

/** Run the copied module in a clean process whose PATH has no real npm. */
function run(module: string, script: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 15_000, env,
  });
}

function baseEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // A failing npm shadows any real install when a test does not supply one.
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: path.join(home, "bin") };
  delete env.PHREN_CODE_PACKAGE; delete env.PHREN_PATH; delete env.PHREN_BRIDGE_HOME;
  return { ...env, ...overrides };
}

const LOAD_SCRIPT = (module: string, store?: string) => `const code = await import(${JSON.stringify(pathToFileURL(module).href)});
const loaded = await code.loadCodePackage(${store === undefined ? "" : JSON.stringify(store)});
console.log(JSON.stringify({ marker: loaded?.marker, from: code.loadedFrom() }));`;

it("resolves PHREN_CODE_PACKAGE first", () => {
  const root = tempDir("code-env-");
  const directory = path.join(root, "pkg"); writePackage(directory, "env");
  const module = copyModule(path.join(root, "modules"));
  const output = run(module, LOAD_SCRIPT(module), baseEnv(path.join(root, "home"), { PHREN_CODE_PACKAGE: directory }));
  expect(JSON.parse(output)).toEqual({ marker: "env", from: directory });
});

it("falls back to the bridge node_modules", () => {
  const root = tempDir("code-bridge-");
  const bridge = path.join(root, "bridge");
  writePackage(path.join(bridge, "node_modules", "@phren", "code"), "bridge");
  const module = copyModule(path.join(root, "modules"));
  const output = run(module, LOAD_SCRIPT(module), baseEnv(path.join(root, "home"), { PHREN_BRIDGE_HOME: bridge }));
  expect(JSON.parse(output)).toEqual({ marker: "bridge", from: path.join(bridge, "node_modules", "@phren", "code") });
});

it("falls back to the store runtime packages", () => {
  const root = tempDir("code-store-");
  const store = path.join(root, "store");
  writePackage(path.join(store, ".runtime", "packages", "node_modules", "@phren", "code"), "store");
  const module = copyModule(path.join(root, "modules"));
  const output = run(module, LOAD_SCRIPT(module, store), baseEnv(path.join(root, "home")));
  expect(JSON.parse(output)).toEqual({ marker: "store", from: path.join(store, ".runtime", "packages", "node_modules", "@phren", "code") });
});

it("imports the bare specifier from an ancestor node_modules", () => {
  const root = tempDir("code-plain-");
  writePackage(path.join(root, "node_modules", "@phren", "code"), "plain");
  const module = copyModule(path.join(root, "modules"));
  const output = run(module, LOAD_SCRIPT(module), baseEnv(path.join(root, "home")));
  expect(JSON.parse(output)).toEqual({ marker: "plain", from: "@phren/code" });
});

it("finds a global npm install through the mise shims PATH", () => {
  const root = tempDir("code-global-");
  const home = path.join(root, "home");
  const shims = path.join(home, ".local", "share", "mise", "shims");
  fs.mkdirSync(shims, { recursive: true });
  const globalRoot = path.join(root, "global");
  fs.writeFileSync(path.join(shims, "npm"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(globalRoot)}\n`, { mode: 0o700 });
  writePackage(path.join(globalRoot, "@phren", "code"), "global");
  const module = copyModule(path.join(root, "modules"));
  const output = run(module, LOAD_SCRIPT(module), baseEnv(home, { PATH: "/bin:/usr/bin", FAKE_GLOBAL_ROOT: globalRoot }));
  expect(JSON.parse(output)).toEqual({ marker: "global", from: path.join(globalRoot, "@phren", "code") });
});

const INSTALL_NPM = `#!/bin/sh
if [ "$1" = "root" ]; then printf '%s\\n' "$FAKE_GLOBAL_ROOT"; exit 0; fi
prefix=""
while [ $# -gt 0 ]; do if [ "$1" = "--prefix" ]; then shift; prefix="$1"; fi; shift; done
mkdir -p "$prefix/node_modules/@phren/code"
cat > "$prefix/node_modules/@phren/code/package.json" <<'JSON'
{"name":"@phren/code","type":"module","exports":{".":"./index.mjs"}}
JSON
printf 'export const marker = "npm-installed";\\n' > "$prefix/node_modules/@phren/code/index.mjs"
`;

it("installs into the store runtime packages with npm when nothing is installed", () => {
  const root = tempDir("code-install-");
  const home = path.join(root, "home");
  const shims = path.join(home, ".local", "share", "mise", "shims");
  fs.mkdirSync(shims, { recursive: true });
  fs.writeFileSync(path.join(shims, "npm"), INSTALL_NPM, { mode: 0o700 });
  const store = path.join(root, "store");
  const module = copyModule(path.join(root, "modules"));
  const output = run(module, `const code = await import(${JSON.stringify(pathToFileURL(module).href)});
const loaded = await code.installCodePackage(${JSON.stringify(store)});
console.log(JSON.stringify({ marker: loaded.marker, from: code.loadedFrom() }));`,
    baseEnv(home, { PATH: "/bin:/usr/bin", FAKE_GLOBAL_ROOT: path.join(root, "empty-global") }));
  expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
    marker: "npm-installed", from: path.join(store, ".runtime", "packages", "node_modules", "@phren", "code"),
  });
});

it("links a workspace checkout instead of installing", () => {
  const root = tempDir("code-workspace-");
  fs.writeFileSync(path.join(root, "placeholder"), "");
  writePackage(path.join(root, "packages", "code"), "workspace");
  const module = copyModule(path.join(root, "packages", "cli", "dist", "modules"));
  const store = path.join(root, "store");
  const output = run(module, `const code = await import(${JSON.stringify(pathToFileURL(module).href)});
const loaded = await code.installCodePackage(${JSON.stringify(store)});
console.log(JSON.stringify({ marker: loaded.marker, from: code.loadedFrom() }));`, baseEnv(path.join(root, "home")));
  expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
    marker: "workspace", from: path.join(store, ".runtime", "packages", "node_modules", "@phren", "code"),
  });
});

it("returns undefined when no copy is available", () => {
  const root = tempDir("code-missing-");
  const module = copyModule(path.join(root, "modules"));
  const output = run(module, LOAD_SCRIPT(module), baseEnv(path.join(root, "home")));
  expect(JSON.parse(output)).toEqual({});
});

it("keeps the same actionable message at the Hook boundary", async () => {
  vi.resetModules();
  vi.doMock("./code-package.js", () => ({
    loadCodePackage: async () => undefined,
    loadedFrom: () => undefined,
    CODE_PACKAGE_HINT: "phren code needs @phren/code: run phren modules enable code",
  }));
  const { CodeRoutes } = await import("../bridge/code-routes.js");
  await expect(new CodeRoutes("/missing-store").status("demo")).rejects.toMatchObject({
    status: 503, message: "phren code needs @phren/code: run phren modules enable code",
  });
});