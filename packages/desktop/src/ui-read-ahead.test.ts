import { describe, expect, it, vi } from "vitest";
// @ts-expect-error read-ahead.js is plain JavaScript without type declarations
import { readAhead } from "../ui/shell/read-ahead.js";

function setup() {
  let time = 1_000;
  let computers = "mini";
  const read = vi.fn(async () => {});
  const ahead = readAhead(read, { key: () => computers, now: () => time, freshMs: 5_000 });
  return { read, ahead, advance: (ms: number) => { time += ms; }, online: (key: string) => { computers = key; } };
}

describe("readAhead", () => {
  it("lets the click show a fresh read ahead instead of reading again", () => {
    const { read, ahead, advance } = setup();
    ahead.prefetch();
    advance(2_000);
    ahead.show();
    expect(read).toHaveBeenCalledTimes(1);
    ahead.show(); // used up: the next show reads
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads on show when the read ahead is stale", () => {
    const { read, ahead, advance } = setup();
    ahead.prefetch();
    advance(6_000);
    ahead.show();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads on show when the online computers changed since the read ahead", () => {
    const { read, ahead, online } = setup();
    ahead.prefetch();
    online("mini\npj");
    ahead.show();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never starts a second read ahead while one for the same computers is fresh", () => {
    const { read, ahead, advance, online } = setup();
    ahead.prefetch();
    advance(1_000);
    ahead.prefetch();
    expect(read).toHaveBeenCalledTimes(1);
    online("pj");
    ahead.prefetch();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
