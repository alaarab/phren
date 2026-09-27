import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

// The built CLI, as an agent would run it (`pnpm build` first).
const cli = path.resolve(process.env.PHREN_TEST_CLI || "packages/cli/dist/index.js");

describe.skipIf(process.platform === "win32" || !existsSync(cli))("phren computers mcp", () => {
  let home: string | undefined;
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; });

  it("serves only read-only computer and usage tools, with no Phren store", async () => {
    home = await mkdtemp(path.join(tmpdir(), "phren-computers-"));
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, PHREN_BRIDGE_HOME: path.join(home, "bridge"), PHREN_TMUX: "off" };
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "computers", "mcp"], env, stderr: "ignore" }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual(["get_resources", "get_usage", "list_computers", "pick_computer"]);
      expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);

      // No Hook here: this computer still reports itself; usage says why it cannot.
      const listed = JSON.parse((await client.callTool({ name: "list_computers", arguments: {} }) as { content: Array<{ text: string }> }).content[0].text);
      expect(listed.hookError).toContain("not running");
      expect(listed.computers).toHaveLength(1);
      expect(listed.computers[0]).toMatchObject({ local: true, online: true, platform: process.platform });
      const usage = await client.callTool({ name: "get_usage", arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(usage.isError).toBe(true);
      expect(usage.content[0].text).toContain("not running");
    } finally { await client.close(); }
    // Nothing was created: no store, no config, no bridge directory.
    expect(await readdir(home)).toEqual([]);
  }, 30_000);
});
