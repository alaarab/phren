import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRecord, SudoReply } from "./sudo.js";
import { readProcess } from "./sudo.js";
import {
  pipeHolders, processTable, runSecretExec, SecretBroker, secretAnswer, secretExecArgs, secretPayload, secretSpec, verifySecretAsker,
  type SecretRequestView,
} from "./secret.js";

const NODE = "/opt/node/bin/node", BUNDLE = "/home/me/.local/share/phren/bridge/current/bridge-hook.mjs", SCRIPT = "/home/me/.local/share/phren/bridge/askpass";
const HELPER = 500, SH = 499, PARENT = 400, COMMAND = 498, GRANDCHILD = 600;
const SECRET = "hunter2 correct horse";

function check(over: { helper?: Partial<ProcessRecord>; script?: Partial<ProcessRecord>; table?: [number, number][]; holders?: number[] | undefined; connection?: "asker" | "other" | "unknown" } = {}) {
  const records: Record<number, ProcessRecord> = {
    [HELPER]: { ppid: SH, euid: 501, name: "node", argv: [], line: `${NODE} ${BUNDLE} askpass --secret-exec`, ...over.helper },
    [SH]: { ppid: PARENT, euid: 501, name: "sh", argv: [], line: `/bin/sh ${SCRIPT} --secret-exec`, ...over.script },
    [COMMAND]: { ppid: PARENT, euid: 501, name: "fdesetup", argv: [], line: "fdesetup disable -inputplist" },
  };
  const table = new Map<number, number>(over.table ?? [[HELPER, SH], [SH, PARENT], [COMMAND, PARENT], [GRANDCHILD, COMMAND], [PARENT, 1]]);
  return { processes: async (pid: number) => records[pid], table: async () => table, node: NODE, bundles: [BUNDLE], script: SCRIPT,
    holders: async (pid: number, exclude: number[]) => { expect([pid, exclude]).toEqual([HELPER, [SH]]); return "holders" in over ? over.holders : [COMMAND]; },
    connection: async () => over.connection ?? "asker" as const };
}

describe("secret-exec arguments and payload", () => {
  it("parses a line request and a plist request", () => {
    expect(secretExecArgs(["--prompt", "FileVault password", "--", "cat"])).toEqual({ spec: { prompt: "FileVault password", format: "line" }, command: ["cat"] });
    expect(secretExecArgs(["--plist", "Password", "--field", "Username=ala", "--", "fdesetup", "disable", "-inputplist"]))
      .toEqual({ spec: { format: "plist", key: "Password", fields: { Username: "ala" } }, command: ["fdesetup", "disable", "-inputplist"] });
  });
  it("refuses requests it cannot show plainly", () => {
    for (const args of [["cat"], ["--"], ["--prompt", "a\nb", "--", "cat"], ["--field", "A=b", "--", "cat"], ["--plist", "Pass word", "--", "cat"], ["--plist", "P", "--field", "P=x", "--", "cat"], ["--bogus", "x", "--", "cat"]]) {
      expect(() => secretExecArgs(args), args.join(" ")).toThrow();
    }
    expect(secretSpec({ format: "line", key: "x" })).toBeUndefined();
    expect(secretSpec({ format: "plist", key: "P", fields: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) })).toBeUndefined();
  });
  it("writes a line, or a plist with every value escaped", () => {
    expect(secretPayload({ format: "line" }, SECRET)).toBe(`${SECRET}\n`);
    const plist = secretPayload({ format: "plist", key: "Password", fields: { Username: "a&b" } }, `<pw>"&`);
    expect(plist).toContain("<key>Username</key>\n\t<string>a&amp;b</string>");
    expect(plist).toContain("<key>Password</key>\n\t<string>&lt;pw&gt;&quot;&amp;</string>");
    expect(plist.startsWith("<?xml")).toBe(true);
  });
  it("accepts one-line secrets and deny only", () => {
    const id = "6cff6dda-d692-4faa-ba31-f5a5f3f8d0c4";
    expect(secretAnswer({ id, secret: SECRET })).toEqual({ id, answer: { secret: SECRET } });
    expect(secretAnswer({ id, deny: true })).toEqual({ id, answer: { deny: true } });
    for (const bad of [{ id, secret: "a\nb" }, { id, secret: "" }, { id, deny: true, secret: "x" }, { id: "x", secret: "y" }]) {
      let message = "";
      try { secretAnswer(bad as never); } catch (error) { message = (error as Error).message; }
      expect(message).toBe("Send an id and a secret, or deny.");
    }
  });
});

describe("verifySecretAsker", () => {
  it("names the one command the helper's pipe reaches", async () => {
    expect(await verifySecretAsker(HELPER, check())).toMatchObject({ commandPid: COMMAND, command: { line: "fdesetup disable -inputplist" } });
    // A reader the command started is still the command; one it reads as root is invisible and fine.
    expect(await verifySecretAsker(HELPER, check({ holders: [COMMAND, GRANDCHILD] }))).toMatchObject({ commandPid: COMMAND });
    expect(await verifySecretAsker(HELPER, check({ holders: [] }))).toMatchObject({ commandPid: COMMAND });
  });
  it("refuses anything else", async () => {
    const refused = async (over: Parameters<typeof check>[0]) => ("refused" in (await verifySecretAsker(HELPER, check(over))) ? (await verifySecretAsker(HELPER, check(over)) as { refused: string }).refused : "accepted");
    expect(await refused({ helper: { line: `${NODE} ${BUNDLE} askpass` } })).toMatch(/only answers phren secret-exec/);
    expect(await refused({ helper: { line: `${NODE} --require x ${BUNDLE} askpass --secret-exec` } })).toMatch(/only answers/);
    expect(await refused({ script: { line: `/bin/sh /tmp/other --secret-exec` } })).toMatch(/only answers/);
    expect(await refused({ helper: { env: ["NODE_OPTIONS"] } })).toMatch(/loads other code/);
    expect(await refused({ table: [[HELPER, SH], [SH, PARENT], [COMMAND, PARENT], [777, PARENT]] })).toBe("phren secret-exec must run exactly one command.");
    expect(await refused({ holders: [COMMAND, PARENT] })).toBe("The secret must go to the command alone.");
    expect(await refused({ holders: undefined })).toBe("Phren Hook could not check where the secret goes.");
    expect(await refused({ connection: "other" })).toBe("Only askpass itself may ask for its secret.");
  });
});

describe("SecretBroker", () => {
  const verified = (deliver: (secret: string) => Promise<SudoReply> = async secret => ({ password: secret })) =>
    async () => ({ command: { ppid: 1, euid: 501, name: "fdesetup", argv: [], line: "fdesetup disable -inputplist" }, deliver });
  const body = { pid: HELPER, cwd: "/tmp", spec: { prompt: "Mac login password", format: "plist", key: "Password", fields: { Username: "ala" } }, dispatchId: "6cff6dda-d692-4faa-ba31-f5a5f3f8d0c4" };
  const make = (deliver?: (secret: string) => Promise<SudoReply>) => new SecretBroker({ computer: () => "Mini", account: "ala", holdMs: 60_000,
    now: () => Date.parse("2026-11-08T12:00:00Z"), label: async () => "FileVault worker", verify: verified(deliver) });

  it("refuses at once when no phone that knows secrets is open", async () => {
    const replies: SudoReply[] = [];
    await make().ask(body, reply => replies.push(reply));
    expect(replies).toEqual([{ status: 503, error: expect.stringContaining("No phone can answer") }]);
  });
  it("shows the command, prompt, stdin shape and session, then hands over the secret once", async () => {
    const broker = make(), frames: SecretRequestView[][] = [], replies: SudoReply[] = [];
    broker.subscribe(requests => frames.push(requests));
    await broker.ask(body, reply => replies.push(reply));
    const [view] = broker.list();
    expect(view).toEqual({ id: expect.any(String), kind: "secret", computer: "Mini", command: "fdesetup disable -inputplist", prompt: "Mac login password",
      stdin: { format: "plist", key: "Password", fields: { Username: "ala" } }, account: "ala", cwd: "/tmp", session: { label: "FileVault worker" },
      askedAt: "2026-11-08T12:00:00.000Z", expiresAt: "2026-11-08T12:01:00.000Z" });
    expect(broker.answer(view.id, { secret: SECRET })).toBe(true);
    await vi.waitFor(() => expect(replies).toEqual([{ password: SECRET }]));
    expect(broker.answer(view.id, { secret: SECRET })).toBe(false);
    expect(broker.list()).toEqual([]);
    expect(JSON.stringify(frames)).not.toContain("hunter2");
  });
  it("denies, and refuses a bad spec before verifying", async () => {
    const broker = make(), replies: SudoReply[] = [];
    broker.subscribe(() => {});
    await broker.ask(body, reply => replies.push(reply));
    broker.answer(broker.list()[0].id, { deny: true });
    await broker.ask({ ...body, spec: { format: "plist" } }, reply => replies.push(reply));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies).toEqual(expect.arrayContaining([{ status: 403, error: "Denied on the phone." }, { status: 400, error: "phren secret-exec sent an invalid request." }]));
  });
});

describe("phren secret-exec processes", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "phren-secret-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("pipes the helper's output into the command alone and returns the command's status", async () => {
    const script = path.join(dir, "askpass"), out = path.join(dir, "got");
    // Stands in for the helper: what it prints is what the command reads.
    await writeFile(script, `printf '%s\\n' "${SECRET}"\n`);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    try {
      expect(await runSecretExec(["--", "/bin/sh", "-c", `cat > '${out}'; exit 3`], { script })).toBe(3);
    } finally { spy.mockRestore(); }
    expect(await readFile(out, "utf8")).toBe(`${SECRET}\n`);
    expect(writes.join("")).not.toContain("hunter2");
  });
  it("stops the command when the helper fails", async () => {
    const script = path.join(dir, "askpass"), out = path.join(dir, "got");
    await writeFile(script, "echo 'phren secret-exec: Denied on the phone.' >&2; exit 1\n");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runSecretExec(["--", "/bin/sh", "-c", `cat > '${out}'; echo ran >> '${out}'`], { script })).toBe(1);
    } finally { err.mockRestore(); }
    expect(await readFile(out, "utf8").catch(() => "")).not.toContain("hunter2");
  });
  it("lets the Hook see a real helper's pipe reach only the command", async () => {
    // A real chain: a parent with two children, /bin/sh <script> --secret-exec (-> node <bundle> askpass --secret-exec)
    // piped into the command, as runSecretExec wires it. A shell pipeline builds that shape in its own process.
    const script = path.join(dir, "askpass"), bundle = path.join(dir, "bridge-hook.mjs"), pidFile = path.join(dir, "pid"), out = path.join(dir, "got");
    await writeFile(bundle, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => process.stdout.write("done\\n"), 60_000);\nprocess.on("SIGTERM", () => process.exit(1));\n`);
    await writeFile(script, `'${process.execPath}' '${bundle}' askpass "$@"\n`);
    const parent = spawn("/bin/sh", ["-c", `/bin/sh '${script}' --secret-exec | /bin/sh -c "cat > '${out}'"`], { stdio: "ignore" });
    const running = new Promise<number | null>(resolve => parent.on("exit", resolve));
    await vi.waitFor(async () => expect(await readFile(pidFile, "utf8").catch(() => "")).not.toBe(""), { timeout: 10_000 });
    const pid = Number(await readFile(pidFile, "utf8"));
    try {
      const result = await verifySecretAsker(pid, { processes: readProcess, table: processTable, holders: pipeHolders, connection: async () => "asker",
        node: process.execPath, bundles: [bundle], script });
      expect(result).toMatchObject({ command: { line: `/bin/sh -c cat > '${out}'` } });
      // Anyone else reading the pipe is refused: here the test itself holds a reader.
      const tee = await verifySecretAsker(pid, { processes: readProcess, table: processTable, holders: async () => [process.pid], connection: async () => "asker",
        node: process.execPath, bundles: [bundle], script });
      expect(tee).toEqual({ refused: "The secret must go to the command alone." });
    } finally { process.kill(pid, "SIGTERM"); }
    expect(await running).toBe(0);
  }, 30_000);
});
