import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PhrenClient talks to its MCP subprocess over stdio; faking child_process.spawn
// lets these tests exercise the real request/response/reconnect logic without
// ever launching a real MCP server. vi.hoisted so the mock factory (which vi.mock
// hoists above the imports below) can reference it.
const { spawnMock, createdProcesses } = vi.hoisted(() => {
  return { spawnMock: vi.fn(), createdProcesses: [] as FakeChildProcess[] };
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// eslint-disable-next-line import/order -- must come after vi.mock for hoisting to apply
import { PhrenClient } from "../src/phrenClient";

interface JsonRpcRequestSeen {
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
}

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
};

function makeFakeProcess(): FakeChildProcess {
  const proc = new EventEmitter() as FakeChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  proc.stdin = {
    write: vi.fn((_data: string, encodingOrCb?: unknown, cb?: unknown) => {
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (typeof callback === "function") callback(undefined);
      return true;
    }),
  };
  return proc;
}

/** Emits a single JSON-RPC response line on the process's stdout. */
function reply(proc: FakeChildProcess, payload: Record<string, unknown>): void {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
}

/** Every request PhrenClient wrote to stdin on this process, decoded. */
function requestsSent(proc: FakeChildProcess): JsonRpcRequestSeen[] {
  return proc.stdin.write.mock.calls.map(([data]) => JSON.parse(String(data).trim()));
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** The most recently spawned fake process — use this, never createdProcesses[0], in
 *  helpers that may construct more than one client per test. */
function lastProcess(): FakeChildProcess {
  return createdProcesses[createdProcesses.length - 1];
}

/** Wires a process to auto-succeed "initialize" and answer every "tools/call"
 * with {ok:true, data:{}}, whatever the request. Reactive (keys off whatever
 * write actually happens) rather than timing/tick-count based. */
function autoRespondEverything(proc: FakeChildProcess) {
  proc.stdin.write = vi.fn((data: string) => {
    const msg = JSON.parse(String(data).trim());
    if (msg.method === "initialize") {
      queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: {} }));
    } else if (msg.method === "tools/call") {
      queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: textResult({ ok: true, data: {} }) }));
    }
    return true;
  });
}

/** Only auto-succeeds "initialize"; tools/call requests are left hanging
 * until the test replies (or times out) — used to test what happens to a
 * specific in-flight tools/call request. */
function autoInitializeOnly(proc: FakeChildProcess) {
  proc.stdin.write = vi.fn((data: string) => {
    const msg = JSON.parse(String(data).trim());
    if (msg.method === "initialize") {
      queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: {} }));
    }
    return true;
  });
}

/** Builds a client whose handshake has already completed, so subsequent
 * calls go straight to a single "tools/call" write with no initialize
 * retry-loop involved. Callers are free to re-wire proc.stdin.write afterward. */
async function readyClient(options: { requestTimeoutMs?: number } = {}): Promise<{ client: PhrenClient; proc: FakeChildProcess }> {
  const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store", ...options });
  const proc = lastProcess();
  autoRespondEverything(proc);
  await client.healthCheck();
  return { client, proc };
}

beforeEach(() => {
  createdProcesses.length = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const proc = makeFakeProcess();
    createdProcesses.push(proc);
    return proc;
  });
  // PhrenClient logs stderr/reconnect activity via console.error; quiet it in
  // test output (still inspectable via vi.mocked(console.error) where a test
  // cares, e.g. the malformed-line test below).
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PhrenClient: process spawning", () => {
  it("spawns the MCP server with [mcpServerPath, storePath] and pipe stdio", () => {
    new PhrenClient({ mcpServerPath: "/mcp/server.js", storePath: "/store" });
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, ["/mcp/server.js", "/store"], { stdio: "pipe" });
  });

  it("uses the configured nodePath instead of the current process's executable when given", () => {
    new PhrenClient({ mcpServerPath: "/mcp/server.js", storePath: "/store", nodePath: "/custom/node" });
    expect(spawnMock).toHaveBeenCalledWith("/custom/node", ["/mcp/server.js", "/store"], { stdio: "pipe" });
  });
});

describe("PhrenClient: initialize handshake", () => {
  it("sends notifications/initialized only after the initialize call succeeds", async () => {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess();
    autoRespondEverything(proc);

    await client.healthCheck();
    const requests = requestsSent(proc);
    const initIndex = requests.findIndex((r) => r.method === "initialize");
    const notifIndex = requests.findIndex((r) => r.method === "notifications/initialized");
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(notifIndex).toBe(initIndex + 1);
    expect(requests[notifIndex].id).toBeUndefined(); // a notification, not a request
  });

  it("falls back through protocol versions in order and stops at the first that succeeds", async () => {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess();
    const seenVersions: unknown[] = [];
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "initialize") {
        seenVersions.push(msg.params!.protocolVersion);
        queueMicrotask(() => {
          if (msg.params!.protocolVersion === "2024-11-05") {
            reply(proc, { jsonrpc: "2.0", id: msg.id, result: {} });
          } else {
            reply(proc, { jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "unsupported version" } });
          }
        });
      } else if (msg.method === "tools/call") {
        queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: textResult({ ok: true, data: {} }) }));
      }
      return true;
    });

    await client.healthCheck();
    expect(seenVersions).toEqual(["2025-06-18", "2025-03-26", "2024-11-05"]);
  });

  it("rejects the call when every protocol version fails to initialize", async () => {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess();
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "initialize") {
        queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "nope" } }));
      }
      return true;
    });

    await expect(client.healthCheck()).rejects.toThrow(/Failed to initialize MCP session/);
  });
});

describe("PhrenClient: request shaping (pins what changed recently)", () => {
  async function callAndCapture(invoke: (client: PhrenClient) => Promise<unknown>): Promise<JsonRpcRequestSeen> {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess(); // must be looked up fresh — this helper may run more than once per test
    autoRespondEverything(proc);
    await invoke(client);
    return requestsSent(proc).find((r) => r.method === "tools/call")!;
  }

  it("getFindings requests limit:200 so the extension never mistakes the MCP tool's default page for the whole project (recent change)", async () => {
    const call = await callAndCapture((c) => c.getFindings("app"));
    expect(call.params).toEqual({ name: "get_findings", arguments: { project: "app", limit: 200 } });
  });

  it("getNotes omits the date key entirely when no date is given, and includes it when one is", async () => {
    const withoutDate = await callAndCapture((c) => c.getNotes("app"));
    expect(withoutDate.params!.arguments).toStrictEqual({ project: "app" });

    const withDate = await callAndCapture((c) => c.getNotes("app", "2026-01-01"));
    expect(withDate.params!.arguments).toStrictEqual({ project: "app", date: "2026-01-01" });
  });

  it("promoteNote only includes findingType when one is passed", async () => {
    const withoutType = await callAndCapture((c) => c.promoteNote("app", "n1"));
    expect(withoutType.params!.arguments).toStrictEqual({ project: "app", note: "n1" });

    const withType = await callAndCapture((c) => c.promoteNote("app", "n1", "pitfall"));
    expect(withType.params!.arguments).toStrictEqual({ project: "app", note: "n1", findingType: "pitfall" });
  });

  it("getAllTasks omits the project key entirely (global board), unlike getTasks which is project-scoped", async () => {
    const all = await callAndCapture((c) => c.getAllTasks({ status: "active+queue", limit: 100 }));
    expect(all.params!.arguments).toStrictEqual({ status: "active+queue", limit: 100 });

    const scoped = await callAndCapture((c) => c.getTasks("app", { status: "all" }));
    expect(scoped.params!.arguments).toStrictEqual({ project: "app", status: "all" });
  });

  it("toggleHooks only adds tool/project/event keys that were actually supplied", async () => {
    const bare = await callAndCapture((c) => c.toggleHooks(true));
    expect(bare.params!.arguments).toStrictEqual({ enabled: true });

    const full = await callAndCapture((c) => c.toggleHooks(false, "claude-code", "app", "PreToolUse"));
    expect(full.params!.arguments).toStrictEqual({ enabled: false, tool: "claude-code", project: "app", event: "PreToolUse" });
  });

  it("linkTaskIssue builds the updates object from only the fields provided (link vs unlink)", async () => {
    const link = await callAndCapture((c) => c.linkTaskIssue("app", "t1", 42, "https://github.com/x/y/issues/42"));
    expect(link.params!.arguments).toStrictEqual({
      project: "app", item: "t1", updates: { github_issue: 42, github_url: "https://github.com/x/y/issues/42" },
    });

    const unlink = await callAndCapture((c) => c.linkTaskIssue("app", "t1", undefined, undefined, true));
    expect(unlink.params!.arguments).toStrictEqual({ project: "app", item: "t1", updates: { unlink_github: true } });
  });

  it("manageReviewItem includes new_text only for edit actions that pass one", async () => {
    const approve = await callAndCapture((c) => c.manageReviewItem("app", "some line", "approve"));
    expect(approve.params!.arguments).toStrictEqual({ project: "app", line: "some line", action: "approve" });

    const edit = await callAndCapture((c) => c.manageReviewItem("app", "some line", "edit", "new line"));
    expect(edit.params!.arguments).toStrictEqual({ project: "app", line: "some line", action: "edit", new_text: "new line" });
  });
});

describe("PhrenClient: response parsing", () => {
  async function callWithRawResult(rawResult: Record<string, unknown>): Promise<unknown> {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess(); // must be looked up fresh — this helper may run more than once per test
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "initialize") queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: {} }));
      if (msg.method === "tools/call") queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: rawResult }));
      return true;
    });
    return client.searchKnowledge("q");
  }

  it("unwraps {content:[{type:text}]} and JSON.parses the text into the resolved value", async () => {
    const value = await callWithRawResult(textResult({ ok: true, data: { hits: ["a"] } }));
    expect(value).toEqual({ ok: true, data: { hits: ["a"] } });
  });

  it("throws using the server's error/message when the unwrapped payload has ok:false (regression: this used to be swallowed, see below)", async () => {
    await expect(callWithRawResult(textResult({ ok: false, error: "bad query" }))).rejects.toThrow("bad query");
    await expect(callWithRawResult(textResult({ ok: false, message: "fallback message" }))).rejects.toThrow("fallback message");
  });

  it("returns the raw text when the text block isn't valid JSON", async () => {
    const value = await callWithRawResult({ content: [{ type: "text", text: "not json at all" }] });
    expect(value).toBe("not json at all");
  });

  it("returns the whole result object when there is no usable text content block", async () => {
    const noContent = await callWithRawResult({});
    expect(noContent).toEqual({});
    const emptyContent = await callWithRawResult({ content: [] });
    expect(emptyContent).toEqual({ content: [] });
  });
});

describe("PhrenClient: stdout framing", () => {
  it("reassembles a JSON-RPC message that arrives split across multiple stdout chunks", async () => {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess();
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "initialize") {
        queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: {} }));
      } else if (msg.method === "tools/call") {
        queueMicrotask(() => {
          const fullLine = `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: textResult({ ok: true, data: {} }) })}\n`;
          const midpoint = Math.floor(fullLine.length / 2);
          proc.stdout.emit("data", Buffer.from(fullLine.slice(0, midpoint)));
          proc.stdout.emit("data", Buffer.from(fullLine.slice(midpoint)));
        });
      }
      return true;
    });

    await expect(client.healthCheck()).resolves.toEqual({ ok: true, data: {} });
  });

  it("processes multiple JSON-RPC lines delivered in a single chunk", async () => {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess();
    const toolCalls: JsonRpcRequestSeen[] = [];
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "initialize") {
        queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: {} }));
      } else if (msg.method === "tools/call") {
        toolCalls.push(msg);
        if (toolCalls.length === 2) {
          queueMicrotask(() => {
            const lines = `${toolCalls
              .map((c) => JSON.stringify({ jsonrpc: "2.0", id: c.id, result: textResult({ ok: true, data: { echo: c.params!.arguments } }) }))
              .join("\n")}\n`;
            proc.stdout.emit("data", Buffer.from(lines));
          });
        }
      }
      return true;
    });

    const [r1, r2] = await Promise.all([client.getFindings("a"), client.getFindings("b")]);
    expect(r1).toEqual({ ok: true, data: { echo: { project: "a", limit: 200 } } });
    expect(r2).toEqual({ ok: true, data: { echo: { project: "b", limit: 200 } } });
  });

  it("ignores a malformed JSON-RPC line instead of crashing the client", async () => {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess();
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "initialize") {
        queueMicrotask(() => reply(proc, { jsonrpc: "2.0", id: msg.id, result: {} }));
      } else if (msg.method === "tools/call") {
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from("this is not json\n"));
          reply(proc, { jsonrpc: "2.0", id: msg.id, result: textResult({ ok: true, data: {} }) });
        });
      }
      return true;
    });

    await expect(client.healthCheck()).resolves.toEqual({ ok: true, data: {} });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("PhrenClient: timeouts and disposal", () => {
  it("rejects a request that never gets a response within requestTimeoutMs", async () => {
    vi.useFakeTimers();
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store", requestTimeoutMs: 50 });
    const proc = lastProcess();
    autoInitializeOnly(proc); // tools/call is deliberately left unanswered

    const promise = client.healthCheck();
    const assertion = expect(promise).rejects.toThrow(/MCP request timed out: tools\/call/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it("dispose() rejects pending requests, kills the process, and blocks further requests", async () => {
    const { client, proc } = await readyClient();
    // Even on an already-initialized client, callTool() still awaits
    // ensureInitialized() before issuing the request — one microtask tick
    // after calling healthCheck() below, not zero. Wait for the write to
    // actually happen (reactively) rather than assuming it's synchronous,
    // so dispose() below is guaranteed to race against a request that is
    // genuinely still in the pending map.
    let sawToolsCall!: () => void;
    const toolsCallSeen = new Promise<void>((resolve) => { sawToolsCall = resolve; });
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "tools/call") sawToolsCall();
      return true; // never replies — disposal should settle it instead
    });

    const pending = client.healthCheck();
    await toolsCallSeen;
    await client.dispose();

    await expect(pending).rejects.toThrow("Phren client disposed.");
    expect(proc.kill).toHaveBeenCalled();
    await expect(client.healthCheck()).rejects.toThrow("Phren client has been disposed.");
  });

  it("dispose() is idempotent and safe to call more than once", async () => {
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const proc = lastProcess();
    await client.dispose();
    await client.dispose();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
});

describe("PhrenClient: reconnect on unexpected process exit", () => {
  it("respawns after RECONNECT_DELAY_MS and gives up after MAX_RECONNECT_RETRIES, after which calls fail fast without spawning again", async () => {
    vi.useFakeTimers();
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const maxRetries = (PhrenClient as unknown as { MAX_RECONNECT_RETRIES: number }).MAX_RECONNECT_RETRIES;
    const delayMs = (PhrenClient as unknown as { RECONNECT_DELAY_MS: number }).RECONNECT_DELAY_MS;
    expect(createdProcesses).toHaveLength(1);

    // Each of the first `maxRetries` exits should spawn one more process.
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      lastProcess().emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(delayMs);
      expect(createdProcesses).toHaveLength(attempt + 1);
    }

    // One more exit past the limit: scheduleReconnect's own guard fires first
    // (reconnectRetries already === maxRetries), so no further process spawns.
    lastProcess().emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(createdProcesses).toHaveLength(maxRetries + 1);

    // And the client now refuses to even try, rather than hanging on a dead pipe.
    await expect(client.healthCheck()).rejects.toThrow(/all reconnect attempts failed/);
    expect(createdProcesses).toHaveLength(maxRetries + 1);
  });

  it("a successful call after reconnecting resets the retry counter, so a later exit is treated as attempt 1 again", async () => {
    vi.useFakeTimers();
    const client = new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const delayMs = (PhrenClient as unknown as { RECONNECT_DELAY_MS: number }).RECONNECT_DELAY_MS;

    lastProcess().emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(delayMs);
    autoRespondEverything(lastProcess());

    await expect(client.healthCheck()).resolves.toEqual({ ok: true, data: {} });

    lastProcess().emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(createdProcesses).toHaveLength(3);
  });

  it("an 'error' event rejects whatever request was in flight, without crashing the client", async () => {
    vi.useFakeTimers(); // this now also arms a reconnect timer (see below) — keep it fake so it can't fire mid-suite
    const { client, proc } = await readyClient();
    // See the dispose() test above for why this waits for the write instead
    // of assuming it happens synchronously before the emit() below.
    let sawToolsCall!: () => void;
    const toolsCallSeen = new Promise<void>((resolve) => { sawToolsCall = resolve; });
    proc.stdin.write = vi.fn((data: string) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "tools/call") sawToolsCall();
      return true; // never replies
    });

    const pending = client.healthCheck();
    await toolsCallSeen;
    proc.emit("error", new Error("spawn EACCES"));
    await expect(pending).rejects.toThrow("spawn EACCES");
  });

  it("an 'error' event also arms a reconnect, same as an exit (regression: spawn failures like ENOENT never fire 'exit', so this used to wedge the client permanently)", async () => {
    vi.useFakeTimers();
    new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const delayMs = (PhrenClient as unknown as { RECONNECT_DELAY_MS: number }).RECONNECT_DELAY_MS;
    expect(createdProcesses).toHaveLength(1);

    lastProcess().emit("error", new Error("spawn ENOENT"));
    await vi.advanceTimersByTimeAsync(delayMs);

    expect(createdProcesses).toHaveLength(2);
  });

  it("does not double-schedule when both 'error' and 'exit' fire for the same failure", async () => {
    vi.useFakeTimers();
    new PhrenClient({ mcpServerPath: "mcp.js", storePath: "/store" });
    const delayMs = (PhrenClient as unknown as { RECONNECT_DELAY_MS: number }).RECONNECT_DELAY_MS;

    const proc = lastProcess();
    proc.emit("error", new Error("ECONNRESET"));
    proc.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(delayMs);

    // Not 3 — the second call into scheduleReconnect() while already
    // reconnecting is a no-op, so only one respawn happens.
    expect(createdProcesses).toHaveLength(2);
  });
});
