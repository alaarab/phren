import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAgentDispatch, clearProjectAuthority, confirmAuthority, consumeConfirmation, listConfirmations, lowerMode,
  projectAuthority, readAuthority, setProjectAuthority,
} from "./authority.js";
import { agentShell, mergedEntry, ownerConfirms, runAuthority, type OwnerTerminal } from "./authority-command.js";

// The policy files must be mode 0600; Windows files carry no POSIX mode bits.
// The Hook that reads them supports macOS and Linux only.
describe.skipIf(process.platform === "win32")("release authority policy", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-authority-")); });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it("starts from the owner's defaults: hub and safety ask-first, Mina go for the App Store", async () => {
    const policy = await readAuthority(root);
    expect(policy.source).toBe("defaults");
    expect(projectAuthority(policy, "hub")).toMatchObject({ listed: true, go: [], ask: ["merge", "publish", "deploy", "app-store", "github-admin"], maxPermissionMode: "auto-edits" });
    expect(projectAuthority(policy, "safety").ask).toHaveLength(5);
    const mina = projectAuthority(policy, "mina");
    expect(mina).toMatchObject({ listed: true, go: expect.arrayContaining(["app-store"]), ask: [] });
    expect(mina.maxPermissionMode).toBeUndefined();
    expect(mina.line).toBe("Release authority for mina (owner policy): go for merge, publish, deploy, app-store, github-admin. Note: Owner authorized App Store work on 2026-09-29.");
    expect(projectAuthority(policy, "hub").line).toBe("Release authority for hub (owner policy): ask-first for merge, publish, deploy, app-store, github-admin; dispatched workers start at most in auto-edits.");
    // A project the policy does not name is restricted by nothing here.
    expect(projectAuthority(policy, "phren")).toMatchObject({ listed: false, ask: [], line: "Release authority for phren (owner policy): no release restrictions listed." });
  });

  it("saves the defaults with the first write, privately, and records who wrote it", async () => {
    const hub = await setProjectAuthority({ project: "hub", default: "ask", actions: { merge: "go" }, maxPermissionMode: "supervised" }, "phone", root);
    expect(hub).toMatchObject({ go: ["merge"], ask: ["publish", "deploy", "app-store", "github-admin"], maxPermissionMode: "supervised" });
    const policy = await readAuthority(root);
    expect(policy).toMatchObject({ source: "file", updatedBy: "phone", projects: { safety: { default: "ask" }, mina: { actions: { "app-store": "go" } } } });
    expect((await stat(path.join(root, "authority.yaml"))).mode & 0o777).toBe(0o600);
    // Clearing makes a project go for everything, defaults or not.
    await clearProjectAuthority({ project: "safety" }, "cli", root);
    expect(projectAuthority(await readAuthority(root), "safety").listed).toBe(false);
    await expect(clearProjectAuthority({ project: "safety" }, "cli", root)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a policy file that is not private or does not parse", async () => {
    const file = path.join(root, "authority.yaml");
    await writeFile(file, "projects:\n  hub: { default: ask }\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(readAuthority(root)).rejects.toMatchObject({ status: 409 });
    await writeFile(file, "projects:\n  hub: { default: maybe }\n", { mode: 0o600 });
    await chmod(file, 0o600);
    await expect(readAuthority(root)).rejects.toMatchObject({ status: 409 });
    // An unquoted timestamp from a hand edit still reads.
    await writeFile(file, "projects: {}\nupdatedAt: 2026-09-29T17:00:00Z\n", { mode: 0o600 });
    expect(await readAuthority(root)).toMatchObject({ source: "file", projects: {}, updatedAt: expect.stringMatching(/^2026-09-29T17:00:00/) });
  });

  it("uses a confirmation once, only for the actions and project it names, and never after it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-29T17:00:00.000Z"));
    await confirmAuthority({ project: "hub", actions: ["merge", "deploy"], minutes: 10 }, "cli", root);
    expect(await consumeConfirmation("safety", ["merge"], root)).toBeUndefined();
    expect(await consumeConfirmation("hub", ["merge", "publish"], root)).toBeUndefined();
    expect(await consumeConfirmation("hub", ["merge"], root)).toMatchObject({ project: "hub", actions: ["merge", "deploy"], by: "cli" });
    expect(await consumeConfirmation("hub", ["merge"], root)).toBeUndefined();
    await confirmAuthority({ project: "hub", actions: ["merge"], minutes: 10 }, "phone", root);
    vi.setSystemTime(Date.parse("2026-09-29T17:11:00.000Z"));
    expect(await listConfirmations(root)).toEqual([]);
    expect(await consumeConfirmation("hub", ["merge"], root)).toBeUndefined();
    await expect(confirmAuthority({ project: "hub", actions: ["merge"], minutes: 24 * 60 + 1 }, "cli", root)).rejects.toThrow();
  });

  describe("an agent's dispatch", () => {
    const hub = { project: "hub", harness: "claude" };
    it("starts at the project's ceiling when it names no mode, and refuses a higher one", async () => {
      expect(await checkAgentDispatch(hub, "auto", root)).toMatchObject({ permissionMode: "auto-edits" });
      expect((await checkAgentDispatch({ ...hub, permissionMode: "supervised" }, "auto", root)).permissionMode).toBeUndefined();
      await expect(checkAgentDispatch({ ...hub, permissionMode: "auto" }, "full-access", root)).rejects.toMatchObject({ status: 403 });
      // The grant's ceiling binds when it is lower.
      expect(await checkAgentDispatch(hub, "supervised", root)).toMatchObject({ permissionMode: "supervised" });
      // A project without a ceiling leaves the mode alone.
      expect((await checkAgentDispatch({ project: "phren", harness: "codex" }, "auto", root)).permissionMode).toBeUndefined();
    });

    it("refuses OpenCode where the project caps the mode, since OpenCode cannot be started lower", async () => {
      await expect(checkAgentDispatch({ project: "hub", harness: "opencode" }, "auto", root)).rejects.toMatchObject({ status: 403 });
      await expect(checkAgentDispatch({ project: "phren", harness: "opencode" }, "auto", root)).resolves.toBeDefined();
    });

    it("refuses ask-first release actions until the owner confirms, then uses the confirmation up", async () => {
      await expect(checkAgentDispatch({ ...hub, releaseActions: ["merge"] }, "auto", root))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining("phren authority confirm hub merge") });
      // Go actions and unlisted projects need nothing.
      await expect(checkAgentDispatch({ project: "mina", harness: "claude", releaseActions: ["app-store"] }, "auto", root)).resolves.toMatchObject({ authority: { project: "mina" } });
      await expect(checkAgentDispatch({ project: "phren", harness: "codex", releaseActions: ["publish"] }, "auto", root)).resolves.toBeDefined();
      const confirmation = await confirmAuthority({ project: "hub", actions: ["merge"] }, "phone", root);
      // A refusal for another reason leaves the confirmation in place.
      await expect(checkAgentDispatch({ ...hub, permissionMode: "auto", releaseActions: ["merge"] }, "auto", root)).rejects.toMatchObject({ status: 403 });
      expect(await checkAgentDispatch({ ...hub, releaseActions: ["merge"] }, "auto", root)).toMatchObject({ confirmation: { id: confirmation.id }, permissionMode: "auto-edits" });
      await expect(checkAgentDispatch({ ...hub, releaseActions: ["merge"] }, "auto", root)).rejects.toMatchObject({ status: 403 });
    });
  });

  it("picks the lower of two ceilings", () => {
    expect(lowerMode("auto", "auto-edits")).toBe("auto-edits");
    expect(lowerMode(undefined, "auto")).toBe("auto");
    expect(lowerMode("full-access", undefined)).toBe("full-access");
  });
});

describe.skipIf(process.platform === "win32")("phren authority", () => {
  let root: string;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const owner = (typed: string, env: NodeJS.ProcessEnv = {}): OwnerTerminal & { asked: string[] } => {
    const asked: string[] = [];
    return { env, interactive: true, asked, ask: async question => { asked.push(question); return typed; } };
  };
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-authority-cli-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); log.mockClear(); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it("knows an agent's shell", () => {
    expect(agentShell({ CLAUDECODE: "1" })).toBe("Claude Code");
    expect(agentShell({ CODEX_THREAD_ID: "019a0000-0000-7000-8000-000000000000" })).toBe("Codex");
    expect(agentShell({ PHREN_FANOUT_JOB: "x" })).toBeDefined();
    expect(agentShell({ TERM: "xterm" })).toBeUndefined();
  });

  it("changes nothing from an agent's shell, without a terminal, or when the owner types something else", async () => {
    await expect(runAuthority(["set", "hub", "--go", "merge"], owner("hub", { CLAUDECODE: "1" }))).rejects.toThrow(/owner's/);
    await expect(runAuthority(["confirm", "hub", "merge"], { ...owner("hub"), interactive: false })).rejects.toThrow(/interactive terminal/);
    await expect(runAuthority(["clear", "hub"], owner("safety"))).rejects.toThrow(/Not confirmed/);
    await expect(ownerConfirms("x", "hub", owner(" hub "))).resolves.toBeUndefined();
    expect((await readAuthority(root)).source).toBe("defaults");
    expect(await listConfirmations(root)).toEqual([]);
  });

  it("merges flags into the project's entry, shows the new line before asking, and saves it", async () => {
    const terminal = owner("hub");
    expect(await runAuthority(["set", "hub", "--go", "merge", "--max-permission-mode", "supervised", "--note", "Ask Dana first."], terminal)).toBe(0);
    expect(terminal.asked[0]).toContain("go for merge; ask-first for publish, deploy, app-store, github-admin; dispatched workers start at most in supervised.");
    expect((await readAuthority(root)).projects.hub).toEqual({ default: "ask", actions: { merge: "go" }, maxPermissionMode: "supervised", note: "Ask Dana first.", });
    expect(await readFile(path.join(root, "authority.yaml"), "utf8")).toContain("updatedBy: cli");
    // A bad value is refused before the owner is asked.
    const second = owner("hub");
    await expect(runAuthority(["set", "hub", "--max-permission-mode", "yolo"], second)).rejects.toThrow();
    await expect(runAuthority(["set", "hub", "--go", "ship"], second)).rejects.toThrow();
    expect(second.asked).toEqual([]);
    expect(await runAuthority(["confirm", "hub", "merge,deploy", "--minutes", "5"], owner("hub"))).toBe(0);
    expect(await listConfirmations(root)).toEqual([expect.objectContaining({ project: "hub", actions: ["merge", "deploy"], by: "cli" })]);
  });

  it("reads the policy for anyone, agents included", async () => {
    expect(await runAuthority(["show", "hub"], owner("", { CLAUDECODE: "1" }))).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ project: "hub", ask: expect.arrayContaining(["merge"]) });
    expect(await runAuthority([], owner("", { CLAUDECODE: "1" }))).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1][0]))).toMatchObject({ source: "defaults", projects: expect.arrayContaining([expect.objectContaining({ project: "safety" })]) });
  });

  it("clears the ceiling and note with none and an empty note, and refuses go and ask for one action", () => {
    expect(mergedEntry({ default: "ask", maxPermissionMode: "auto", note: "x" }, { "max-permission-mode": "none", note: "" })).toEqual({ default: "ask" });
    expect(() => mergedEntry(undefined, { go: "merge", ask: "merge" })).toThrow(/both go and ask/);
  });
});
