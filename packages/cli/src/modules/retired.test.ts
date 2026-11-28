import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../package-metadata.js";
import { makeTempDir } from "../test-helpers.js";
import { setModuleEnabled } from "./config.js";
import { enabled, readConfig } from "./registry.js";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => { tmp = makeTempDir("retired-modules-"); });
afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });

const file = () => path.join(tmp.path, ".config", "modules.yaml");
const write = (text: string) => {
  fs.mkdirSync(path.join(tmp.path, ".config"), { recursive: true });
  fs.writeFileSync(file(), text);
};

describe("retired module names", () => {
  it("ignores tasks on read without warning but still warns for genuinely unknown names", () => {
    write(`version: 1
enabled:
  tasks: true
  future-module: true
profiles:
  work:
    enabled:
      tasks: false
`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(enabled(tmp.path).map(module => module.name)).toEqual(["memory"]);
    expect(enabled(tmp.path, "work").map(module => module.name)).toEqual(["memory"]);
    expect(error.mock.calls.map(([line]) => String(line)))
      .toEqual([`warning: unknown module "future-module" in .config/modules.yaml ignored by Hook ${VERSION}`]);
  });

  it("drops tasks from the store and profile overrides when phren writes modules.yaml", () => {
    write(`version: 1
enabled:
  tasks: true
profiles:
  work:
    enabled:
      tasks: false
`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readConfig(tmp.path)?.enabled).toBeUndefined();
    setModuleEnabled(tmp.path, "git", true);
    const saved = fs.readFileSync(file(), "utf8");
    expect(saved).not.toContain("tasks");
    expect(saved).toContain("git: true");
  });
});
