import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carryCodexHookTrust, codexHookHash, codexHookTrustText } from "./codex-hook-trust.js";

const NODE = "'/home/alaarab/.local/share/mise/installs/node/26.7.0/bin/node'";
const PROGRAM = "/home/alaarab/.local/share/phren/bridge/current/bridge-hook.mjs";
const PHREN = `${NODE} '${PROGRAM}' hook codex`;
const MOSHI = "'/home/alaarab/.local/bin/moshi-hook' codex-hook";
const HERDR = "bash '/home/alaarab/.codex/herdr-agent-state.sh' session";
const HOOKS_PATH = "/home/alaarab/.codex/hooks.json";

const phren = (timeout: number) => ({ hooks: [{ type: "command", command: PHREN, timeout }] });
const other = (command: string, timeout?: number) => ({ hooks: [{ command, ...(timeout ? { timeout } : {}), type: "command" }] });

/** Linuxbox's hooks.json with Phren's session callbacks at `timeout`. */
function hooksJson(timeout: number): string {
  return JSON.stringify({ hooks: {
    PermissionRequest: [other(MOSHI), { hooks: [{ type: "command", command: PHREN, timeout: 60 }] }],
    SessionStart: [other(HERDR, 10), other(MOSHI), phren(timeout)],
    Stop: [other(MOSHI), phren(timeout)],
    UserPromptSubmit: [other(MOSHI), phren(timeout)],
    PreToolUse: [phren(10)],
    PostToolUse: [phren(10)],
  } }, null, 2) + "\n";
}

const table = (key: string, hash: string, extra = "") => `[hooks.state."${HOOKS_PATH}:${key}"]\ntrusted_hash = "${hash}"\n${extra}\n`;

/** Linuxbox's config.toml, trusted while Phren's session callbacks were at 3 s. */
const CONFIG = [
  'model = "gpt-5.5"\n\n[features]\nhooks = true\n\n[mcp_servers.phren]\ncommand = "node"\n\n[hooks.state]\n\n',
  table("session_start:0:0", "sha256:20ac17f15582f4f45b2622557b7cd34f3e0ff0d4f477b59d679b6621f9b5c936"),
  table("permission_request:0:0", "sha256:41cdec35e4aa4ceabd331d1d45bd5390af4ce389b9cfc5b80df13e39b0d298c0", "enabled = true\n"),
  table("session_start:1:0", "sha256:d26d53e74b5c6bdd4bcd0e2c0fb91e1a7e07f66e0c9dc483347fa0871d08f1e4"),
  table("user_prompt_submit:0:0", "sha256:9d3b871ba5617c6e2e1692964b543c3ae50ebd7fe31271e30d6cc25f706a2351"),
  table("stop:0:0", "sha256:900d0b9ea69972c2df4bf2221a4646e41b8871d3ea1c82a2f3a37ad22726d989"),
  table("permission_request:1:0", "sha256:6b53f9427411ef087cc8ee65b296126bc951961065483b03b461496462ece434"),
  table("session_start:2:0", "sha256:29b61baf8a029ace439714e9b6a8ddbbc69c442167ed4f16270c90f41a80d046"),
  table("user_prompt_submit:1:0", "sha256:2b3204d3d5503b7cd5224d5588b085f184590b617e3e6b4ff7a41637a24cb2bd"),
  table("stop:1:0", "sha256:3d9f307186e7eaf9414d9922f2a4dbbc86856f3923ca2b3e899a9cc77a7243d9"),
  table("pre_tool_use:0:0", "sha256:36ee15939a5c44633658074c2ab2e8b6fa7dd225abef3019efd8dca73d7f7eca"),
  table("post_tool_use:0:0", "sha256:469120aaf94242a1e71d220c19153d73d61868a05991de55600c2f27c36f3325"),
  '[tui]\nnotifications = true\n',
].join("");

/** Every handler in a hooks.json text whose stored hash matches, the check Codex makes. */
function untrusted(config: string, hooks: string): string[] {
  const parsed = JSON.parse(hooks) as { hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> };
  const bad: string[] = [];
  for (const [event, groups] of Object.entries(parsed.hooks)) groups.forEach((group, g) => group.hooks.forEach((handler, h) => {
    const key = `${HOOKS_PATH}:${event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}:${g}:${h}`;
    if (!config.includes(`[hooks.state."${key}"]\ntrusted_hash = "${codexHookHash(event, group, handler)}"`)) bad.push(key);
  }));
  return bad;
}

describe("codex hook trust", () => {
  const temporary: string[] = [];
  afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

  it("hashes handlers exactly as Codex does (Linuxbox fixtures)", () => {
    const run = (event: string, handler: Record<string, unknown>) => codexHookHash(event, {}, { type: "command", ...handler });
    expect(run("PreToolUse", { command: PHREN, timeout: 10 })).toBe("sha256:36ee15939a5c44633658074c2ab2e8b6fa7dd225abef3019efd8dca73d7f7eca");
    expect(run("PostToolUse", { command: PHREN, timeout: 10 })).toBe("sha256:469120aaf94242a1e71d220c19153d73d61868a05991de55600c2f27c36f3325");
    expect(run("PermissionRequest", { command: PHREN, timeout: 60 })).toBe("sha256:6b53f9427411ef087cc8ee65b296126bc951961065483b03b461496462ece434");
    expect(run("SessionStart", { command: HERDR, timeout: 10 })).toBe("sha256:20ac17f15582f4f45b2622557b7cd34f3e0ff0d4f477b59d679b6621f9b5c936");
    expect(run("SessionStart", { command: MOSHI })).toBe("sha256:d26d53e74b5c6bdd4bcd0e2c0fb91e1a7e07f66e0c9dc483347fa0871d08f1e4");
    expect(run("SessionStart", { command: PHREN, timeout: 3 })).toBe("sha256:29b61baf8a029ace439714e9b6a8ddbbc69c442167ed4f16270c90f41a80d046");
    expect(run("Stop", { command: PHREN, timeout: 3 })).toBe("sha256:3d9f307186e7eaf9414d9922f2a4dbbc86856f3923ca2b3e899a9cc77a7243d9");
    expect(run("UserPromptSubmit", { command: PHREN, timeout: 3 })).toBe("sha256:2b3204d3d5503b7cd5224d5588b085f184590b617e3e6b4ff7a41637a24cb2bd");
  });

  it("includes a matcher only when the group has one", () => {
    const handler = { type: "command", command: PHREN, timeout: 10 };
    expect(codexHookHash("PreToolUse", { matcher: null }, handler)).toBe(codexHookHash("PreToolUse", {}, handler));
    expect(codexHookHash("PreToolUse", { matcher: "Bash" }, handler)).not.toBe(codexHookHash("PreToolUse", {}, handler));
  });

  it("carries trust from timeout 3 to 15 and keeps the rest of config.toml byte for byte", () => {
    const hooks = hooksJson(15);
    expect(untrusted(CONFIG, hooks)).toEqual([`${HOOKS_PATH}:session_start:2:0`, `${HOOKS_PATH}:stop:1:0`, `${HOOKS_PATH}:user_prompt_submit:1:0`]);
    const result = codexHookTrustText(CONFIG, hooks, PROGRAM, [HOOKS_PATH], hooksJson(3))!;
    expect(result.carried.sort()).toEqual([`${HOOKS_PATH}:session_start:2:0`, `${HOOKS_PATH}:stop:1:0`, `${HOOKS_PATH}:user_prompt_submit:1:0`]);
    // All 11 handlers now match, as on Linuxbox before the rewrite.
    expect(untrusted(result.text, hooks)).toEqual([]);
    const changed = result.text.split("\n").filter((line, i) => line !== CONFIG.split("\n")[i]);
    expect(changed).toHaveLength(3);
    expect(changed.every(line => line.startsWith('trusted_hash = "sha256:'))).toBe(true);
    // An already-broken computer (no before text) is repaired the same way.
    expect(codexHookTrustText(CONFIG, hooks, PROGRAM, [HOOKS_PATH])!.text).toBe(result.text);
    // Idempotent.
    expect(codexHookTrustText(result.text, hooks, PROGRAM, [HOOKS_PATH], hooksJson(3))).toBeUndefined();
  });

  it("follows a Phren group that moved to another index", () => {
    const moved = JSON.parse(hooksJson(15)) as { hooks: Record<string, unknown[]> };
    moved.hooks.Stop = [other(MOSHI), other("'/usr/bin/extra' stop"), phren(15)];
    const hooks = JSON.stringify(moved, null, 2);
    const result = codexHookTrustText(CONFIG, hooks, PROGRAM, [HOOKS_PATH], hooksJson(3))!;
    expect(result.carried).toContain(`${HOOKS_PATH}:stop:2:0`);
    expect(result.text).toContain(`[hooks.state."${HOOKS_PATH}:stop:2:0"]\ntrusted_hash = "${codexHookHash("Stop", {}, phren(15).hooks[0])}"\n\n[tui]`);
    // The new user entry at Phren's old index is not trusted.
    expect(untrusted(result.text, hooks)).toContain(`${HOOKS_PATH}:stop:1:0`);
  });

  it("carries trust across a node path change only from the pre-install hooks.json", () => {
    const oldNode = hooksJson(3).replaceAll(NODE, "'/usr/bin/node'");
    const config = codexHookTrustText(CONFIG.replaceAll("29b61baf8a029ace439714e9b6a8ddbbc69c442167ed4f16270c90f41a80d046",
      codexHookHash("SessionStart", {}, { type: "command", command: `'/usr/bin/node' '${PROGRAM}' hook codex`, timeout: 3 }).slice(7)), hooksJson(15), PROGRAM, [HOOKS_PATH], oldNode);
    expect(config?.carried).toContain(`${HOOKS_PATH}:session_start:2:0`);
  });

  it("never trusts a Phren handler the owner never trusted, nor anyone else's", () => {
    const withoutPhren = CONFIG.split(/(?=\[hooks\.state\.")/).filter(t => !/session_start:2:0|stop:1:0|user_prompt_submit:1:0/.test(t)).join("");
    expect(codexHookTrustText(withoutPhren, hooksJson(15), PROGRAM, [HOOKS_PATH], hooksJson(3))).toBeUndefined();
    // A hash of some other command for the event does not count.
    const forged = CONFIG.replace("29b61baf8a029ace439714e9b6a8ddbbc69c442167ed4f16270c90f41a80d046", "0".repeat(64));
    expect(codexHookTrustText(forged, hooksJson(15), PROGRAM, [HOOKS_PATH], hooksJson(3))?.carried).not.toContain(`${HOOKS_PATH}:session_start:2:0`);
    // A modified non-Phren entry stays modified.
    const edited = hooksJson(15).replaceAll(`"command": "${MOSHI}"`, `"command": "${MOSHI} --verbose"`);
    const result = codexHookTrustText(CONFIG, edited, PROGRAM, [HOOKS_PATH])!;
    expect(result.carried.every(key => /session_start:2:0|stop:1:0|user_prompt_submit:1:0/.test(key))).toBe(true);
    expect(untrusted(result.text, edited)).toContain(`${HOOKS_PATH}:session_start:1:0`);
    // No stored trust at all: nothing.
    expect(codexHookTrustText('model = "x"\n', hooksJson(15), PROGRAM, [HOOKS_PATH], hooksJson(3))).toBeUndefined();
  });

  it("repairs $CODEX_HOME in place, keeps the mode, and stands down with PHREN_PRETRUST=off", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "phren-codex-hooks-"))); temporary.push(home);
    const codex = path.join(home, "codex"); await mkdir(codex);
    const hooksFile = path.join(codex, "hooks.json"), configFile = path.join(codex, "config.toml");
    const hooks = hooksJson(15).replaceAll(PROGRAM, path.join(home, "bridge/current/bridge-hook.mjs"));
    const config = CONFIG.replaceAll(HOOKS_PATH, hooksFile).replace(/sha256:(29b61b|3d9f30|2b3204)[0-9a-f]+/g, hash => {
      const event = hash.startsWith("sha256:29b61b") ? "SessionStart" : hash.startsWith("sha256:3d9f30") ? "Stop" : "UserPromptSubmit";
      return codexHookHash(event, {}, { type: "command", command: `${NODE} '${path.join(home, "bridge/current/bridge-hook.mjs")}' hook codex`, timeout: 3 });
    });
    await writeFile(hooksFile, hooks); await writeFile(configFile, config, { mode: 0o640 });
    const program = path.join(home, "bridge/current/bridge-hook.mjs");
    const env = { HOME: home, CODEX_HOME: codex };
    expect(await carryCodexHookTrust(program, undefined, { ...env, PHREN_PRETRUST: "off" })).toEqual([]);
    expect(await readFile(configFile, "utf8")).toBe(config);
    expect(await carryCodexHookTrust(program, undefined, env)).toHaveLength(3);
    const repaired = await readFile(configFile, "utf8");
    expect(repaired).not.toBe(config);
    expect((await stat(configFile)).mode & 0o777).toBe(0o640);
    expect(await carryCodexHookTrust(program, undefined, env)).toEqual([]);
    expect(await readFile(configFile, "utf8")).toBe(repaired);
  });

  it("does nothing without config.toml or hooks.json", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "phren-codex-hooks-"))); temporary.push(home);
    expect(await carryCodexHookTrust(PROGRAM, undefined, { HOME: home, CODEX_HOME: home })).toEqual([]);
    await writeFile(path.join(home, "hooks.json"), hooksJson(15));
    expect(await carryCodexHookTrust(PROGRAM, undefined, { HOME: home, CODEX_HOME: home })).toEqual([]);
  });
});
