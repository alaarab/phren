import { expect, it } from "vitest";
import type { ProcessRow } from "../bridge/resources.js";
import { parseCpuTimes, reapRows, testClones } from "./reap.js";

const now = Date.parse("2026-11-15T12:00:00Z"), day = 86_400_000;
const row = (pid: number, ppid: number, command: string, args: string, rssMB = 100, ageMs = day): ProcessRow =>
  ({ pid, ppid, pgid: pid, cpu: 0, rssKB: rssMB * 1024, command, args, startedAt: now - ageMs });
const table = [
  row(10, 1, "/usr/local/bin/claude", "claude"),
  row(11, 10, "/bin/zsh", "zsh -c until ! pgrep -f 'vitest run'; do sleep 5; done", 4),
  row(12, 10, "/bin/zsh", "zsh -c while [ $(pgrep -x xcodebuild | wc -l) -gt 1 ]; do sleep 5; done", 4),
  row(20, 10, "node", "node /w/app/node_modules/.bin/vite --port 5173", 300, 7 * day),
  row(21, 20, "esbuild", "esbuild --service=0.25.0 --ping", 200, 7 * day),
  row(30, 1, "java", "java -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10", 5000, 2 * day),
  row(40, 50, "node", "node /home/me/site/node_modules/.bin/vite", 250),
  row(50, 1, "/bin/bash", "bash"),
  row(60, 50, "/bin/zsh", "zsh -c until ! pgrep -f reap; do sleep 1; done; phren reap", 4),
  row(61, 60, "node", "node phren reap", 80),
  row(70, 10, "node", "node /w/node_modules/vitest/vitest.mjs run", 2000),
];

it("lists what agents left running with memory, age and the stop command, never the report's own callers", () => {
  const first = reapRows(table, { now, cpu: new Map([[20, 40], [30, 600]]), samples: {}, self: 61 });
  expect(first.rows.map(r => [r.kind, r.name, r.pid, r.by])).toEqual([
    ["dev server", "vite", 20, "claude (pid 10)"],
    ["build daemon", "Gradle daemon", 30, "parent gone"],
    ["wait loop", "pgrep -f wait loop", 11, "claude (pid 10)"],
  ]);
  // vite's esbuild child counts toward it; idle time is unknown until a second report.
  expect(first.rows[0]).toMatchObject({ rssBytes: 500 * 1024 ** 2, ageMs: 7 * day, stop: "kill 20" });
  expect(first.rows[0].idleMs).toBeUndefined();
  // An hour later vite's CPU time has not moved and Gradle's has.
  const second = reapRows(table, { now: now + 3_600_000, cpu: new Map([[20, 40], [30, 700]]), samples: first.samples, self: 61 });
  expect(second.rows.find(r => r.pid === 20)?.idleMs).toBe(3_600_000);
  expect(second.rows.find(r => r.pid === 30)?.idleMs).toBe(0);
  // The person's own dev server shows only when asked for everything.
  expect(reapRows(table, { now, cpu: new Map(), samples: {}, self: 61, all: true }).rows.map(r => r.pid)).toContain(40);
});

it("attributes work whose agent is gone by the session ids in its environment", () => {
  const orphan = [row(80, 77, "node", "node node_modules/.bin/next dev"), row(77, 1, "/bin/sh", "sh")];
  const env = (pid: number) => pid === 80 ? "HOME=/h\0CODEX_THREAD_ID=0199aa11-2222\0" : undefined;
  expect(reapRows(orphan, { now, cpu: new Map(), samples: {}, env }).rows).toMatchObject([{ name: "next dev", by: "codex thread 0199aa11 (gone)" }]);
});

it("finds test database clones beside their template and reads ps CPU times", () => {
  expect(testClones([{ name: "hub_test", connections: 1 }, { name: "hub_test_797", bytes: 2e9, connections: 0 }, { name: "hub_test_fix_a1", connections: 0 },
    { name: "hub", connections: 3 }, { name: "hub_prod_2", connections: 0 }, { name: "o'test_1", connections: 0 }, { name: "o'test", connections: 0 }]))
    .toEqual([{ name: "hub_test_797", template: "hub_test", bytes: 2e9, connections: 0, stop: "dropdb 'hub_test_797'" },
      { name: "hub_test_fix_a1", template: "hub_test", connections: 0, stop: "dropdb 'hub_test_fix_a1'" },
      { name: "o'test_1", template: "o'test", connections: 0, stop: "dropdb 'o'\\''test_1'" }]);
  expect(parseCpuTimes("  20   0:40.12\n  30 1-02:03:04\n")).toEqual(new Map([[20, 40], [30, 93_784]]));
});
