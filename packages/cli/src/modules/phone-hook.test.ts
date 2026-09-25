import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { enableHookForPhone, initializeModules } from "./config.js";
import { moduleSnapshot } from "./runtime.js";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => { tmp = makeTempDir("phone-hook-"); });
afterEach(() => tmp.cleanup());

it("turns the Hook on for a fresh store once, and leaves a store-less home alone", () => {
  const store = path.join(tmp.path, "store");
  expect(enableHookForPhone(store)).toBe(false);
  expect(fs.existsSync(store)).toBe(false);
  initializeModules(store);
  expect(moduleSnapshot(store).has("hook")).toBe(false);
  expect(enableHookForPhone(store)).toBe(true);
  expect(moduleSnapshot(store).has("hook")).toBe(true);
  expect(enableHookForPhone(store)).toBe(false);
});
