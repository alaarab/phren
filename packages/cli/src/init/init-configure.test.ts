import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { configureMcpTargets } from "./init-configure.js";
import { resetVSCodeProbeCache } from "./config.js";
import { presetCapabilities } from "./management-preset.js";

const DIST_ENTRY = path.resolve(__dirname, "..", "..", "dist", "index.js");
const NO_WRAPPERS = presetCapabilities("assisted");

function phrenServer(phrenPath: string) {
  return { command: "node", args: [DIST_ENTRY, phrenPath] };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, jsonText(value));
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function codexSection(phrenPath: string): string {
  return [
    "[mcp_servers.phren]",
    'command = "node"',
    `args = [${JSON.stringify(DIST_ENTRY)}, ${JSON.stringify(phrenPath)}]`,
    "startup_timeout_sec = 30",
  ].join("\n");
}

describe("configureMcpTargets", () => {
  let tmp: { path: string; cleanup: () => void };
  let home: string;
  let phrenPath: string;
  let claudeSettings: string;
  let vscodeMcp: string;
  let cursorMcp: string;
  let copilotMcp: string;
  let codexDir: string;
  let codexToml: string;

  beforeEach(() => {
    tmp = makeTempDir("phren-init-configure-");
    home = path.join(tmp.path, "home");
    phrenPath = path.join(tmp.path, "phren");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(phrenPath, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("PHREN_PATH", phrenPath);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
    vi.stubEnv("CODEX_HOME", path.join(home, ".codex"));
    vi.stubEnv("COPILOT_HOME", path.join(home, ".copilot"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    resetVSCodeProbeCache();

    claudeSettings = path.join(home, ".claude", "settings.json");
    vscodeMcp = path.join(home, ".config", "Code", "User", "mcp.json");
    cursorMcp = path.join(home, ".cursor", "mcp.json");
    copilotMcp = path.join(home, ".copilot", "mcp-config.json");
    codexDir = path.join(home, ".codex");
    codexToml = path.join(codexDir, "config.toml");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetVSCodeProbeCache();
    tmp.cleanup();
  });

  it("writes the phren MCP server into every detected agent config on first run", () => {
    fs.mkdirSync(path.join(home, ".config", "Code", "User"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(home, ".copilot"), { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    const status = configureMcpTargets(phrenPath, {
      mcpEnabled: true,
      hooksEnabled: false,
      caps: NO_WRAPPERS,
    });

    expect(status).toBe("installed");
    expect(readText(claudeSettings)).toBe(
      jsonText({ mcpServers: { phren: phrenServer(phrenPath) }, hooks: {} })
    );
    expect(readText(vscodeMcp)).toBe(
      jsonText({ servers: { phren: phrenServer(phrenPath) } })
    );
    expect(readText(cursorMcp)).toBe(
      jsonText({ mcpServers: { phren: phrenServer(phrenPath) } })
    );
    expect(readText(copilotMcp)).toBe(
      jsonText({ mcpServers: { phren: phrenServer(phrenPath) } })
    );
    expect(readText(codexToml)).toBe(codexSection(phrenPath) + "\n");
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("appends the Codex TOML section after existing user content", () => {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(codexToml, 'model = "gpt-5"\napproval_policy = "on-request"\n');

    const status = configureMcpTargets(phrenPath, {
      mcpEnabled: true,
      hooksEnabled: false,
      caps: NO_WRAPPERS,
    });

    expect(status).toBe("installed");
    expect(readText(codexToml)).toBe(
      'model = "gpt-5"\napproval_policy = "on-request"\n\n' + codexSection(phrenPath) + "\n"
    );
  });

  it("is idempotent: a second run rewrites the same MCP blocks without duplicating them", () => {
    writeJson(claudeSettings, {
      mcpServers: { other: { command: "uvx", args: ["other-server"] } },
    });
    writeJson(cursorMcp, {
      mcpServers: { other: { command: "uvx", args: ["cursor-other"] } },
    });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(codexToml, 'model = "gpt-5"\n');

    const opts = { mcpEnabled: true, hooksEnabled: false, caps: NO_WRAPPERS };
    expect(configureMcpTargets(phrenPath, opts)).toBe("installed");
    expect(configureMcpTargets(phrenPath, opts)).toBe("installed");

    expect(readText(claudeSettings)).toBe(
      jsonText({
        mcpServers: {
          other: { command: "uvx", args: ["other-server"] },
          phren: phrenServer(phrenPath),
        },
        hooks: {},
      })
    );
    expect(readText(cursorMcp)).toBe(
      jsonText({
        mcpServers: {
          other: { command: "uvx", args: ["cursor-other"] },
          phren: phrenServer(phrenPath),
        },
      })
    );
    expect(readText(codexToml)).toBe('model = "gpt-5"\n\n' + codexSection(phrenPath) + "\n");
    expect(readText(codexToml).match(/\[mcp_servers\.phren\]/g)).toHaveLength(1);
  });

  it("preserves user keys in Claude settings, ~/.claude.json and Cursor config", () => {
    writeJson(claudeSettings, {
      theme: "dark",
      permissions: { allow: ["Bash(ls:*)"] },
      mcpServers: { other: { command: "uvx", args: ["other-server"] } },
    });
    writeJson(path.join(home, ".claude.json"), {
      numStartups: 42,
      mcpServers: { existing: { command: "node", args: ["existing.js"] } },
    });
    writeJson(cursorMcp, {
      mcpServers: { other: { command: "uvx", args: ["cursor-other"] } },
      "editor.fontSize": 14,
    });

    const status = configureMcpTargets(phrenPath, {
      mcpEnabled: true,
      hooksEnabled: false,
      caps: NO_WRAPPERS,
    });

    expect(status).toBe("installed");
    expect(readText(claudeSettings)).toBe(
      jsonText({
        theme: "dark",
        permissions: { allow: ["Bash(ls:*)"] },
        mcpServers: {
          other: { command: "uvx", args: ["other-server"] },
          phren: phrenServer(phrenPath),
        },
        hooks: {},
      })
    );
    expect(readText(path.join(home, ".claude.json"))).toBe(
      jsonText({
        numStartups: 42,
        mcpServers: {
          existing: { command: "node", args: ["existing.js"] },
          phren: phrenServer(phrenPath),
        },
      })
    );
    expect(readText(cursorMcp)).toBe(
      jsonText({
        mcpServers: {
          other: { command: "uvx", args: ["cursor-other"] },
          phren: phrenServer(phrenPath),
        },
        "editor.fontSize": 14,
      })
    );
  });

  it("leaves a malformed Claude settings file untouched and still configures other agents", () => {
    const malformed = '{ "mcpServers": { "phren": ';
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, malformed);
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });

    const status = configureMcpTargets(phrenPath, {
      mcpEnabled: true,
      hooksEnabled: false,
      caps: NO_WRAPPERS,
    });

    expect(status).toBe("installed");
    expect(readText(claudeSettings)).toBe(malformed);
    expect(readText(cursorMcp)).toBe(
      jsonText({ mcpServers: { phren: phrenServer(phrenPath) } })
    );
  });

  it("removes phren from every JSON config on disable while keeping other servers", () => {
    const oldPhren = { command: "npx", args: ["-y", "phren", "/old/path"] };
    writeJson(claudeSettings, {
      mcpServers: { phren: oldPhren, other: { command: "uvx", args: ["other"] } },
    });
    writeJson(vscodeMcp, {
      servers: { phren: oldPhren, other: { command: "uvx", args: ["other"] } },
    });
    writeJson(cursorMcp, {
      mcpServers: { phren: oldPhren, other: { command: "uvx", args: ["other"] } },
    });
    writeJson(copilotMcp, {
      mcpServers: { phren: oldPhren, other: { command: "uvx", args: ["other"] } },
    });
    writeJson(path.join(codexDir, "config.json"), {
      mcpServers: { phren: oldPhren, other: { command: "uvx", args: ["other"] } },
      model: "o3",
    });

    const status = configureMcpTargets(phrenPath, {
      mcpEnabled: false,
      hooksEnabled: false,
      caps: NO_WRAPPERS,
    });

    expect(status).toBe("disabled");
    expect(readText(claudeSettings)).toBe(
      jsonText({
        mcpServers: { other: { command: "uvx", args: ["other"] } },
        hooks: {},
      })
    );
    expect(readText(vscodeMcp)).toBe(
      jsonText({ servers: { other: { command: "uvx", args: ["other"] } } })
    );
    expect(readText(cursorMcp)).toBe(
      jsonText({ mcpServers: { other: { command: "uvx", args: ["other"] } } })
    );
    expect(readText(copilotMcp)).toBe(
      jsonText({ mcpServers: { other: { command: "uvx", args: ["other"] } } })
    );
    expect(readText(path.join(codexDir, "config.json"))).toBe(
      jsonText({
        mcpServers: { other: { command: "uvx", args: ["other"] } },
        model: "o3",
      })
    );
  });

  it("removes only the Codex [mcp_servers.phren] TOML section on disable", () => {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      codexToml,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.phren]",
        'command = "npx"',
        'args = ["-y", "phren", "/old/path"]',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
      ].join("\n")
    );

    const status = configureMcpTargets(phrenPath, {
      mcpEnabled: false,
      hooksEnabled: false,
      caps: NO_WRAPPERS,
    });

    expect(status).toBe("disabled");
    expect(readText(codexToml)).toBe(
      ['model = "gpt-5"', "", "[mcp_servers.other]", 'command = "other"', ""].join("\n")
    );
  });

  it("forwards hooksEnabled to Claude and repeats without duplicating lifecycle hooks", () => {
    const userHook = {
      matcher: "",
      hooks: [{ type: "command", command: "echo keep-me", timeout: 5 }],
    };
    writeJson(claudeSettings, { hooks: { UserPromptSubmit: [userHook] } });

    const opts = { mcpEnabled: true, hooksEnabled: true, caps: NO_WRAPPERS };
    expect(configureMcpTargets(phrenPath, opts)).toBe("installed");
    expect(configureMcpTargets(phrenPath, opts)).toBe("installed");

    const enabled = JSON.parse(readText(claudeSettings));
    expect(enabled.hooks.UserPromptSubmit).toContainEqual(userHook);
    for (const event of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"]) {
      expect(Array.isArray(enabled.hooks[event])).toBe(true);
    }
    const markerEntries = enabled.hooks.UserPromptSubmit.filter((entry: any) =>
      entry.hooks?.some((hook: any) => String(hook.command).includes("hook-prompt"))
    );
    expect(markerEntries).toHaveLength(1);

    expect(
      configureMcpTargets(phrenPath, {
        mcpEnabled: true,
        hooksEnabled: false,
        caps: NO_WRAPPERS,
      })
    ).toBe("installed");

    const disabled = JSON.parse(readText(claudeSettings));
    expect(disabled.hooks.UserPromptSubmit).toEqual([userHook]);
    const serializedHooks = JSON.stringify(disabled.hooks);
    for (const marker of ["hook-prompt", "hook-stop", "hook-session-start", "hook-tool"]) {
      expect(serializedHooks).not.toContain(marker);
    }
  });
});
