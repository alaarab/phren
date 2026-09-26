import { describe, expect, it } from "vitest";
import {
  canonicalizeArgs,
  chainKey,
  createRepeatChain,
  recordCall,
  resetRepeatChain,
  REPEAT_THRESHOLDS,
} from "../guards/repeat-tool-reminder.js";
import { runToolsConcurrently } from "../agent-loop/stream.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolUseBlock } from "../providers/types.js";

describe("canonicalizeArgs", () => {
  it("is order-independent for object keys, at any depth", () => {
    expect(canonicalizeArgs({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalizeArgs({ b: { c: 3, d: 2 }, a: 1 }));
  });

  it("distinguishes genuinely different arguments", () => {
    expect(canonicalizeArgs({ a: 1 })).not.toBe(canonicalizeArgs({ a: 2 }));
    expect(canonicalizeArgs([1, 2])).not.toBe(canonicalizeArgs([2, 1])); // array order matters
  });
});

describe("repeat chain", () => {
  it("reminds at each threshold with escalating detail", () => {
    const chain = createRepeatChain();
    const notes: Array<string | null> = [];
    for (let i = 1; i <= 8; i++) {
      notes.push(recordCall(chain, "read_file", { path: "/a" }));
    }
    // thresholds 3, 5, 8
    expect(notes.filter(Boolean)).toHaveLength(REPEAT_THRESHOLDS.length);
    expect(notes[2]).toContain("repeating the exact same tool call");
    expect(notes[4]).toContain('call 5 of "read_file"');
    expect(notes[7]).toContain('call 8 of "read_file"');
    expect(notes[0]).toBeNull();
    expect(notes[3]).toBeNull();
  });

  it("a different call resets the run to 1", () => {
    const chain = createRepeatChain();
    recordCall(chain, "read_file", { path: "/a" });
    recordCall(chain, "read_file", { path: "/a" });
    recordCall(chain, "read_file", { path: "/b" }); // different args
    expect(chain.count).toBe(1);
    expect(chain.key).toBe(chainKey("read_file", { path: "/b" }));
  });

  it("user input resets the chain", () => {
    const chain = createRepeatChain();
    recordCall(chain, "grep", { q: "x" });
    recordCall(chain, "grep", { q: "x" });
    resetRepeatChain(chain);
    expect(recordCall(chain, "grep", { q: "x" })).toBeNull();
    expect(chain.count).toBe(1);
  });

  it("caps the argument preview but never the detection", () => {
    const chain = createRepeatChain();
    const bigArgs = { content: "x".repeat(2000) };
    let note: string | null = null;
    for (let i = 0; i < 5; i++) note = recordCall(chain, "write_file", bigArgs);
    expect(note).not.toBeNull();
    expect(note!).toContain("chars omitted");
    // The reminder is bounded even though the arguments are 2000+ chars
    expect(note!.length).toBeLessThan(1000);
    expect(chain.count).toBe(5); // full-args detection still counted every call
  });
});

describe("pre-batch dedupe in runToolsConcurrently", () => {
  function block(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
    return { type: "tool_use", id, name, input };
  }

  it("executes identical calls once and shares the result with a note", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "counted",
      description: "counts executions",
      input_schema: {},
      async execute() {
        executions++;
        return { output: `run ${executions}` };
      },
    });
    registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

    const results = await runToolsConcurrently(
      [
        block("c1", "counted", { q: 1 }),
        block("c2", "counted", { q: 1 }), // duplicate
        block("c3", "counted", { q: 2 }), // different args
      ],
      registry,
    );

    expect(executions).toBe(2);
    expect(results).toHaveLength(3);
    expect(results[0].block.id).toBe("c1");
    expect(results[0].output).toBe("run 1");
    expect(results[1].block.id).toBe("c2");
    expect(results[1].output).toContain("duplicate call");
    expect(results[2].output).toBe("run 2");
  });

  it("enforces the per-tool timeout budget and aborts the signal", async () => {
    let sawAbort = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "never finishes on its own",
      input_schema: {},
      timeoutMs: 150,
      async execute(_input, signal) {
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ output: "aborted cooperatively" });
          });
        });
      },
    });
    registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

    const results = await runToolsConcurrently([block("s1", "slow", {})], registry);
    expect(results[0].is_error).toBe(true);
    expect(results[0].output).toContain("timed out after 0.15s");
    expect(sawAbort).toBe(true);
  });
});
