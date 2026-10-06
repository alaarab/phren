import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAgentDispatch, clearProjectAuthority, confirmAuthority, consumeConfirmation, listConfirmations, lowerMode,
  projectAuthority, readAuthority, setProjectAuthority,
} from "./authority.js";
import { agentShell, mergedEntry, ownerConfirms, runAuthority, type OwnerTerminal } from "./authority-command.js";

/** A written policy: harbor and beacon ask-first, orbit go for App Store work. */
async function seed(root: string): Promise<void> {
  const file = path.join(root, "authority.yaml");
  await writeFile(file, "projects:\n  harbor: { default: ask }\n  beacon: { default: ask }\n  orbit:\n    actions: { app-store: go }\n    note: App Store work approved.\n", { mode: 0o600 });
  await chmod(file, 0o600);
}

// The policy files must be mode 0600; Windows files carry no POSIX mode bits.
// The Hook that reads them supports macOS and Linux only.
describe.skipIf(process.platform === "win32")("release authority policy", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-authority-")); });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it("restricts nothing until the owner writes a policy", async () => {
    const policy = await readAuthority(root);
    expect(policy).toMatchObject({ source: "defaults", projects: {} });
    expect(projectAuthority(policy, "harbor")).toMatchObject({ listed: false, ask: [], line: "Release authority for harbor (owner policy): no release restrictions listed." });
  });

  it("reads a written policy: ask-first projects, go actions and notes", async () => {
    await seed(root);
    const policy = await readAuthority(root);
    expect(policy.source).toBe("file");
    expect(projectAuthority(policy, "harbor")).toMatchObject({ listed: true, go: [], ask: ["merge", "publish", "deploy", "app-store", "github-admin"], maxPermissionMode: "auto-edits" });
    expect(projectAuthority(policy, "beacon").ask).toHaveLength(5);
    const orbit = projectAuthority(policy, "orbit");
    expect(orbit).toMatchObject({ listed: true, go: expect.arrayContaining(["app-store"]), ask: [] });
    expect(orbit.maxPermissionMode).toBeUndefined();
    expect(orbit.line).toBe("Release authority for orbit (owner policy): go for merge, publish, deploy, app-store, github-admin. Note: App Store work approved.");
    expect(projectAuthority(policy, "harbor").line).toBe("Release authority for harbor (owner policy): ask-first for merge, publish, deploy, app-store, github-admin; dispatched workers start at most in auto-edits.");
    // A project the policy does not name is restricted by nothing here.
    expect(projectAuthority(policy, "phren")).toMatchObject({ listed: false, ask: [], line: "Release authority for phren (owner policy): no release restrictions listed." });
  });

  it("saves the first write privately, records who wrote it, and keeps the other projects", async () => {
    const first = await setProjectAuthority({ project: "beacon", default: "ask" }, "cli", root);
    expect(first.ask).toHaveLength(5);
    const harbor = await setProjectAuthority({ project: "harbor", default: "ask", actions: { merge: "go" }, maxPermissionMode: "supervised" }, "phone", root);
    expect(harbor).toMatchObject({ go: ["merge"], ask: ["publish", "deploy", "app-store", "github-admin"], maxPermissionMode: "supervised" });
    const policy = await readAuthority(root);
    expect(policy).toMatchObject({ source: "file", updatedBy: "phone", projects: { beacon: { default: "ask" }, harbor: { default: "ask" } } });
    expect((await stat(path.join(root, "authority.yaml"))).mode & 0o777).toBe(0o600);
    // Clearing makes a project go for everything.
    await clearProjectAuthority({ project: "beacon" }, "cli", root);
    expect(projectAuthority(await readAuthority(root), "beacon").listed).toBe(false);
    await expect(clearProjectAuthority({ project: "beacon" }, "cli", root)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a policy file that is not private or does not parse", async () => {
    const file = path.join(root, "authority.yaml");
    await writeFile(file, "projects:\n  harbor: { default: ask }\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(readAuthority(root)).rejects.toMatchObject({ status: 409 });
    await writeFile(file, "projects:\n  harbor: { default: maybe }\n", { mode: 0o600 });
    await chmod(file, 0o600);
    await expect(readAuthority(root)).rejects.toMatchObject({ status: 409 });
    // An unquoted timestamp from a hand edit still reads.
    await writeFile(file, "projects: {}\nupdatedAt: 2026-09-29T17:00:00Z\n", { mode: 0o600 });
    expect(await readAuthority(root)).toMatchObject({ source: "file", projects: {}, updatedAt: expect.stringMatching(/^2026-09-29T17:00:00/) });
  });

  it("uses a confirmation once, only for the actions and project it names, and never after it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-29T17:00:00.000Z"));
    await confirmAuthority({ project: "harbor", actions: ["merge", "deploy"], minutes: 10 }, "cli", root);
    expect(await consumeConfirmation("beacon", ["merge"], root)).toBeUndefined();
    expect(await consumeConfirmation("harbor", ["merge", "publish"], root)).toBeUndefined();
    expect(await consumeConfirmation("harbor", ["merge"], root)).toMatchObject({ project: "harbor", actions: ["merge", "deploy"], by: "cli" });
    expect(await consumeConfirmation("harbor", ["merge"], root)).toBeUndefined();
    await confirmAuthority({ project: "harbor", actions: ["merge"], minutes: 10 }, "phone", root);
    vi.setSystemTime(Date.parse("2026-09-29T17:11:00.000Z"));
    expect(await listConfirmations(root)).toEqual([]);
    expect(await consumeConfirmation("harbor", ["merge"], root)).toBeUndefined();
    await expect(confirmAuthority({ project: "harbor", actions: ["merge"], minutes: 24 * 60 + 1 }, "cli", root)).rejects.toThrow();
  });

  describe("an agent's dispatch", () => {
    const harbor = { project: "harbor", harness: "claude" };
    beforeEach(() => seed(root));
    it("starts at the project's ceiling when it names no mode, and refuses a higher one", async () => {
      expect(await checkAgentDispatch(harbor, "auto", root)).toMatchObject({ permissionMode: "auto-edits" });
      expect((await checkAgentDispatch({ ...harbor, permissionMode: "supervised" }, "auto", root)).permissionMode).toBeUndefined();
      await expect(checkAgentDispatch({ ...harbor, permissionMode: "auto" }, "full-access", root)).rejects.toMatchObject({ status: 403 });
      // The grant's ceiling binds when it is lower.
      expect(await checkAgentDispatch(harbor, "supervised", root)).toMatchObject({ permissionMode: "supervised" });
      // A project without a ceiling leaves the mode alone.
      expect((await checkAgentDispatch({ project: "phren", harness: "codex" }, "auto", root)).permissionMode).toBeUndefined();
    });

    it("refuses OpenCode where the project caps the mode, since OpenCode cannot be started lower", async () => {
      await expect(checkAgentDispatch({ project: "harbor", harness: "opencode" }, "auto", root)).rejects.toMatchObject({ status: 403 });
      await expect(checkAgentDispatch({ project: "phren", harness: "opencode" }, "auto", root)).resolves.toBeDefined();
    });

    it("refuses ask-first release actions until the owner confirms, then uses the confirmation up", async () => {
      await expect(checkAgentDispatch({ ...harbor, releaseActions: ["merge"] }, "auto", root))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining("phren authority confirm harbor merge") });
      // Go actions and unlisted projects need nothing.
      await expect(checkAgentDispatch({ project: "orbit", harness: "claude", releaseActions: ["app-store"] }, "auto", root)).resolves.toMatchObject({ authority: { project: "orbit" } });
      await expect(checkAgentDispatch({ project: "phren", harness: "codex", releaseActions: ["publish"] }, "auto", root)).resolves.toBeDefined();
      const confirmation = await confirmAuthority({ project: "harbor", actions: ["merge"] }, "phone", root);
      // A refusal for another reason leaves the confirmation in place.
      await expect(checkAgentDispatch({ ...harbor, permissionMode: "auto", releaseActions: ["merge"] }, "auto", root)).rejects.toMatchObject({ status: 403 });
      expect(await checkAgentDispatch({ ...harbor, releaseActions: ["merge"] }, "auto", root)).toMatchObject({ confirmation: { id: confirmation.id }, permissionMode: "auto-edits" });
      await expect(checkAgentDispatch({ ...harbor, releaseActions: ["merge"] }, "auto", root)).rejects.toMatchObject({ status: 403 });
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
    await expect(runAuthority(["set", "harbor", "--go", "merge"], owner("harbor", { CLAUDECODE: "1" }))).rejects.toThrow(/owner's/);
    await expect(runAuthority(["confirm", "harbor", "merge"], { ...owner("harbor"), interactive: false })).rejects.toThrow(/interactive terminal/);
    await expect(runAuthority(["clear", "harbor"], owner("beacon"))).rejects.toThrow(/Not confirmed/);
    await expect(ownerConfirms("x", "harbor", owner(" harbor "))).resolves.toBeUndefined();
    expect((await readAuthority(root)).source).toBe("defaults");
    expect(await listConfirmations(root)).toEqual([]);
  });

  it("merges flags into the project's entry, shows the new line before asking, and saves it", async () => {
    await seed(root);
    const terminal = owner("harbor");
    expect(await runAuthority(["set", "harbor", "--go", "merge", "--max-permission-mode", "supervised", "--note", "Ask Dana first."], terminal)).toBe(0);
    expect(terminal.asked[0]).toContain("go for merge; ask-first for publish, deploy, app-store, github-admin; dispatched workers start at most in supervised.");
    expect((await readAuthority(root)).projects.harbor).toEqual({ default: "ask", actions: { merge: "go" }, maxPermissionMode: "supervised", note: "Ask Dana first.", });
    expect(await readFile(path.join(root, "authority.yaml"), "utf8")).toContain("updatedBy: cli");
    // A bad value is refused before the owner is asked.
    const second = owner("harbor");
    await expect(runAuthority(["set", "harbor", "--max-permission-mode", "yolo"], second)).rejects.toThrow();
    await expect(runAuthority(["set", "harbor", "--go", "ship"], second)).rejects.toThrow();
    expect(second.asked).toEqual([]);
    expect(await runAuthority(["confirm", "harbor", "merge,deploy", "--minutes", "5"], owner("harbor"))).toBe(0);
    expect(await listConfirmations(root)).toEqual([expect.objectContaining({ project: "harbor", actions: ["merge", "deploy"], by: "cli" })]);
  });

  it("reads the policy for anyone, agents included", async () => {
    await seed(root);
    expect(await runAuthority(["show", "harbor"], owner("", { CLAUDECODE: "1" }))).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ project: "harbor", ask: expect.arrayContaining(["merge"]) });
    expect(await runAuthority([], owner("", { CLAUDECODE: "1" }))).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1][0]))).toMatchObject({ source: "file", projects: expect.arrayContaining([expect.objectContaining({ project: "beacon" })]) });
  });

  it("clears the ceiling and note with none and an empty note, and refuses go and ask for one action", () => {
    expect(mergedEntry({ default: "ask", maxPermissionMode: "auto", note: "x" }, { "max-permission-mode": "none", note: "" })).toEqual({ default: "ask" });
    expect(() => mergedEntry(undefined, { go: "merge", ask: "merge" })).toThrow(/both go and ask/);
  });
});
