import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(),
  mkdir: async () => { throw new Error("fixture: storage unavailable"); },
}));
import { serve } from "./server.js";
// Windows has no process umask (process.umask() always reads 0 there).
it.skipIf(process.platform === "win32")("sets a private process umask before its first storage operation, even on failed startup", async () => {
  const previous = process.umask(0o022);
  try {
    await expect(serve("test")).rejects.toThrow("fixture: storage unavailable");
    expect(process.umask()).toBe(0o077);
  } finally { process.umask(previous); }
});
