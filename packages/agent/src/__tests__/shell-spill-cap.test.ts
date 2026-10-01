import { describe, expect, it } from "vitest";
import * as fs from "fs";
import { createShellTool, removeSpillFiles } from "../tools/shell.js";

// Its own file: the session total is per process (module) state.
const posix = process.platform !== "win32";

describe.skipIf(!posix)("full-output session cap", () => {
  it("stops writing full-output files once the session total is reached", async () => {
    const saved = process.env.PHREN_AGENT_SHELL_SPILL_TOTAL_BYTES;
    process.env.PHREN_AGENT_SHELL_SPILL_TOTAL_BYTES = "50000";
    try {
      const result = await createShellTool().execute({ command: "seq 1 40000" });
      expect(result.output).toMatch(/file capped at \d+ bytes/);
      const file = /is in (\S+?\.log)/.exec(result.output)![1];
      expect(fs.statSync(file).size).toBeLessThan(100_000);
      const next = await createShellTool().execute({ command: "seq 1 40000" });
      expect(next.output).toMatch(/Full output was not saved/);
      expect(next.output).not.toMatch(/is in \S+\.log/);
    } finally {
      if (saved === undefined) delete process.env.PHREN_AGENT_SHELL_SPILL_TOTAL_BYTES;
      else process.env.PHREN_AGENT_SHELL_SPILL_TOTAL_BYTES = saved;
      removeSpillFiles();
    }
  });
});
