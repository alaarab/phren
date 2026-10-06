import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../package-metadata.js";
import { makeTempDir } from "../test-helpers.js";
import { moduleSnapshot } from "./runtime.js";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => { tmp = makeTempDir("module-runtime-"); });
afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });

function configure(text: string): void {
  fs.mkdirSync(path.join(tmp.path, ".config"), { recursive: true });
  fs.writeFileSync(path.join(tmp.path, ".config", "modules.yaml"), text);
}

describe("module runtime loading", () => {
  it("ignores an unknown module key with one warning and keeps known values", () => {
    const source = "version: 1\nenabled:\n  hook: true\n  tasks: false\n  future-module: true\n";
    configure(source);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const snapshot = moduleSnapshot(tmp.path, "");
    expect(snapshot.has("memory")).toBe(true);
    expect(snapshot.has("hook")).toBe(true);
    expect(snapshot.has("tasks")).toBe(false);
    expect(snapshot.has("future-module")).toBe(false);
    expect(error.mock.calls.map(([line]) => String(line)))
      .toEqual([`warning: unknown module "future-module" in .config/modules.yaml ignored by Hook ${VERSION}`]);
    expect(fs.readFileSync(path.join(tmp.path, ".config", "modules.yaml"), "utf8")).toBe(source);
  });

  it("warns once per key across repeated reads in the same process", () => {
    configure("version: 1\nenabled:\n  future-key-once: true\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(moduleSnapshot(tmp.path, "").has("future-key-once")).toBe(false);
    expect(moduleSnapshot(tmp.path, "").has("future-key-once")).toBe(false);
    expect(error.mock.calls.filter(([line]) => String(line).includes("future-key-once"))).toHaveLength(1);
  });
});
