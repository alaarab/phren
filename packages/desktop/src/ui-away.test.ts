import { describe, expect, it } from "vitest";
import { MIN_AWAY_MS, createAway } from "../ui/shell/away.js";

const row = (id: string, agentStatus: string) => ({ key: `mini/${id}`, computer: "mini", child: { id, title: `Task ${id}`, agentStatus } });

function clock() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe("away", () => {
  it("lists the turns that ended while away, newest first, once back", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    away.observe([row("a", "working"), row("b", "working"), row("c", "idle")]);
    away.leave();
    c.tick(30_000);
    away.observe([row("a", "idle"), row("b", "working"), row("c", "idle")]);
    c.tick(60_000);
    away.observe([row("a", "idle"), row("b", "waiting"), row("c", "working")]);
    away.back();
    expect(away.current()?.rows.map((r) => r.key)).toEqual(["mini/b", "mini/a"]);
    away.dismiss();
    expect(away.current()).toBeNull();
  });

  it("ignores a short absence and turns that ended while you were here", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    away.observe([row("a", "working")]);
    away.observe([row("a", "idle")]); // here: not counted
    away.observe([row("a", "working")]);
    away.leave();
    away.observe([row("a", "idle")]);
    c.tick(MIN_AWAY_MS - 1);
    away.back();
    expect(away.current()).toBeNull();
  });
});
