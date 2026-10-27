import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addClaudeAccount, signInClaudeAccount } from "./account-add.js";
import { clearAccountCaches, type AuthStatus } from "./claude-accounts.js";
import { BridgeError, object, type Json } from "./protocol.js";
import { setTerminalProvider } from "./terminal.js";

it("refuses a bad slug with a suggested one the phone can offer", async () => {
  const refusal = (input: unknown) => addClaudeAccount(input, "default").then(() => undefined, (error: unknown) => error);
  const named = await refusal({ slug: "Buildbox" });
  expect(named).toBeInstanceOf(BridgeError);
  expect(named).toMatchObject({ status: 400, details: { suggestedSlug: "buildbox" } });
  expect((named as BridgeError).message).toContain('Try "buildbox".');
  expect(await refusal({ slug: "Buildbox", email: "sam@example.com" })).toMatchObject({ status: 400, details: { suggestedSlug: "sam-example" } });
  expect(await refusal({ slug: "../../bad" })).toMatchObject({ status: 400, details: { suggestedSlug: "bad" } });
  expect(await refusal({ slug: "default" })).toMatchObject({ status: 400, details: { suggestedSlug: "default-2" } });
});

describe("signing in an existing account slot", () => {
  let home = "", bin = "", claude = "", restore: () => void = () => {};
  const panes: Json[] = [], commands: string[] = [];
  const signedOut = async (): Promise<AuthStatus> => ({ signedIn: false, reason: "Not signed in" });
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-sign-in-"));
    // The `claude` the Hook finds on its PATH: it says which home it was run under.
    bin = path.join(home, "bin"); mkdirSync(bin); claude = path.join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\nprintf '%s' \"${CLAUDE_CONFIG_DIR-unset}\"\n", { mode: 0o755 });
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    vi.stubEnv("PATH", `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`);
    clearAccountCaches();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".claude-work"), { recursive: true });
    writeFileSync(path.join(home, ".claude-work", ".claude.json"), "{}");
    panes.length = 0; commands.length = 0;
    restore = setTerminalProvider({
      listPanes: async () => panes,
      create: async () => { panes.push({ server: "default", workspace: "w9", tab: "w9:t1", pane: `w9:p${panes.length + 1}` }); },
      shellCommand: async (_server: string, _pane: string, command: string) => { commands.push(command); },
    } as never);
  });
  afterEach(() => { restore(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  // Codex review of #667: both snapshotted, both created, both saw two new panes and refused, leaving two panes.
  it("opens one pane each for two slots signed in at once, on a terminal that doesn't name its new pane", async () => {
    mkdirSync(path.join(home, ".claude-spare"), { recursive: true });
    writeFileSync(path.join(home, ".claude-spare", ".claude.json"), "{}");
    // Creating takes a moment, so the two requests overlap.
    restore();
    restore = setTerminalProvider({
      listPanes: async () => [...panes],
      create: async () => { await new Promise(resolve => setTimeout(resolve, 10)); panes.push({ server: "default", workspace: "w9", tab: "w9:t1", pane: `w9:p${panes.length + 1}` }); },
      shellCommand: async (_server: string, pane: string, command: string) => { commands.push(`${pane} ${command}`); },
    } as never);
    const [work, spare] = await Promise.all([signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedOut),
      signInClaudeAccount({ slug: "spare", mode: "sign-in" }, "default", signedOut)]);
    expect(panes).toHaveLength(2);
    expect(new Set([object(work.target).pane, object(spare.target).pane])).toEqual(new Set(["w9:p1", "w9:p2"]));
    expect(commands).toHaveLength(2);
    expect(commands.find(command => command.includes(".claude-spare"))).toMatch(new RegExp(`^${String(object(spare.target).pane)} `));
  });

  it("takes the pane the terminal says it created, though another pane opened at the same moment", async () => {
    restore();
    restore = setTerminalProvider({
      listPanes: async () => [...panes],
      // A launch opens a pane on the same computer while this one is created.
      create: async () => {
        panes.push({ server: "default", workspace: "w8", tab: "w8:t1", pane: "w8:p1" }, { server: "default", workspace: "w9", tab: "w9:t1", pane: "w9:p7" });
        return { workspace: "w9", tab: "w9:t1", pane: "w9:p7" };
      },
      shellCommand: async (_server: string, pane: string, command: string) => { commands.push(`${pane} ${command}`); },
    } as never);
    expect(await signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedOut))
      .toMatchObject({ target: { server: "default", workspace: "w9", tab: "w9:t1", pane: "w9:p7" } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^w9:p7 /);
  });

  it("opens claude /login under a signed-out slot's own home", async () => {
    const answer = await signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedOut);
    expect(answer).toMatchObject({ target: { server: "default", pane: "w9:p1", source: "claude" }, terminalOnly: true, slug: "work" });
    expect(commands).toEqual([`env CLAUDE_CONFIG_DIR='${path.join(home, ".claude-work")}' '${claude}' /login`]);
    // While that pane is open, another sign-in for the slot is refused.
    await expect(signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedOut)).rejects.toMatchObject({ status: 409 });
    expect(commands).toHaveLength(1);
  });

  it("signs in the default slot with CLAUDE_CONFIG_DIR removed", async () => {
    await signInClaudeAccount({ slug: "default", mode: "sign-in" }, "default", signedOut);
    expect(commands).toEqual([`env -u CLAUDE_CONFIG_DIR '${claude}' /login`]);
  });

  it("names the default slot's home when the Hook's is not ~/.claude", async () => {
    // The Hook was started with CLAUDE_CONFIG_DIR; the pane's own shell may not have it.
    const elsewhere = path.join(home, "it's elsewhere");
    mkdirSync(elsewhere);
    vi.stubEnv("CLAUDE_CONFIG_DIR", elsewhere);
    await signInClaudeAccount({ slug: "default", mode: "sign-in" }, "default", signedOut);
    expect(commands).toEqual([`env CLAUDE_CONFIG_DIR='${path.join(home, "it'\\''s elsewhere")}' '${claude}' /login`]);
  });

  it("names ~/.claude when the Hook found the default slot through CLAUDE_CONFIG_DIR set to it", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
    await signInClaudeAccount({ slug: "default", mode: "sign-in" }, "default", signedOut);
    expect(commands).toEqual([`env CLAUDE_CONFIG_DIR='${path.join(home, ".claude")}' '${claude}' /login`]);
  });

  it("falls back to the bare command when the Hook finds no claude", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    await signInClaudeAccount({ slug: "default", mode: "sign-in" }, "default", signedOut);
    expect(commands).toEqual(["env -u CLAUDE_CONFIG_DIR claude /login"]);
  });

  // A pane shell that exports another account's home (the owner's profile) must not decide which one signs in.
  it.skipIf(process.platform === "win32")("runs claude under the slot's home whatever the pane's shell exports", async () => {
    const run = (command: string) => execFileSync("/bin/sh", ["-c", command], { encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: path.join(home, ".claude-work") } });
    await signInClaudeAccount({ slug: "default", mode: "sign-in" }, "default", signedOut);
    await signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedOut);
    expect(commands.map(run)).toEqual(["unset", path.join(home, ".claude-work")]);
  });

  it("asks afresh whether the slot is signed in while its sign-in pane is open", async () => {
    const asked: boolean[] = [];
    const auth = async (_home: unknown, options: { fresh: boolean }): Promise<AuthStatus> => { asked.push(options.fresh); return { signedIn: false }; };
    await signInClaudeAccount({ slug: "work", mode: "sign-in-status" }, "default", auth);
    await signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", auth);
    await signInClaudeAccount({ slug: "work", mode: "sign-in-status" }, "default", auth);
    expect(asked).toEqual([false, false, true]);
  });

  it("lets a slot that signed in, then out again, be signed in again while the old pane is still open", async () => {
    await signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedOut);
    // The pane signed it in and stays open as a Claude session; later the slot signs out.
    expect(await signInClaudeAccount({ slug: "work", mode: "sign-in-status" }, "default", async () => ({ signedIn: true }))).toMatchObject({ signedIn: true });
    expect(await signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedOut)).toMatchObject({ target: { pane: "w9:p2" } });
    expect(commands).toHaveLength(2);
  });

  it("refuses a slot that is signed in, or that does not exist, saying why", async () => {
    const signedIn = async (): Promise<AuthStatus> => ({ signedIn: true, plan: "max" });
    await expect(signInClaudeAccount({ slug: "work", mode: "sign-in" }, "default", signedIn))
      .rejects.toMatchObject({ status: 409, message: 'Claude account "work" is already signed in.', details: { code: "signed-in" } });
    await expect(signInClaudeAccount({ slug: "spare", mode: "sign-in" }, "default", signedOut))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining("Add it first") });
    await expect(signInClaudeAccount({ slug: "Work Box", mode: "sign-in" }, "default", signedOut)).rejects.toMatchObject({ status: 400 });
    expect(commands).toEqual([]);
  });

  it("reports whether the slot is signed in yet, for the phone to poll", async () => {
    expect(await signInClaudeAccount({ slug: "work", mode: "sign-in-status" }, "default", signedOut)).toEqual({ slug: "work", signedIn: false });
    expect(await signInClaudeAccount({ slug: "work", mode: "sign-in-status" }, "default", async () => ({ signedIn: true, plan: "pro" })))
      .toEqual({ slug: "work", signedIn: true, plan: "pro" });
    expect(panes).toEqual([]);
  });
});
