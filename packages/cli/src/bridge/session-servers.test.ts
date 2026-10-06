import { describe, expect, it } from "vitest";
import { attributeServers, descendsFrom, mentionedPorts } from "./session-servers.js";
import type { LocalServer } from "./projects.js";

const server = (port: number, pid: number): LocalServer => ({ name: `App on ${port}`, port, origin: `http://127.0.0.1:${port}`, pid });

// Two panes on one computer. Pane A's shell is 100, running the agent 110,
// whose tool shell 120 started a dev server 121. Pane B's shell 200 started
// its own server 201. A detached server 300 was reparented to launchd (1).
const parents = new Map<number, number>([
  [100, 50], [110, 100], [120, 110], [121, 120],
  [200, 50], [201, 200],
  [300, 1],
  [400, 1], [401, 400],
]);
const servers = [server(3000, 121), server(4000, 201), server(5173, 300), server(8080, 401)];

describe("session web servers", () => {
  it("lists a server the session's own pane started, and nothing another pane started", () => {
    const result = attributeServers({ servers, parents, ownRoots: new Set([100]), otherRoots: new Set([200]), mentioned: new Set() });
    expect(result.map(entry => [entry.port, entry.source])).toEqual([[3000, "started"]]);
  });

  it("finds a detached server the transcript mentions, labelled as mentioned", () => {
    const result = attributeServers({ servers, parents, ownRoots: new Set([100]), otherRoots: new Set([200]), mentioned: new Set([5173]) });
    expect(result.map(entry => [entry.port, entry.source])).toEqual([[3000, "started"], [5173, "mentioned"]]);
  });

  it("never claims a mentioned port that another pane's process tree owns", () => {
    const result = attributeServers({ servers, parents, ownRoots: new Set([100]), otherRoots: new Set([200]), mentioned: new Set([4000]) });
    expect(result.map(entry => entry.port)).toEqual([3000]);
  });

  it("counts a background-job agent's own process (a transcript holder) as the session", () => {
    // The agent's tools run under 400, which is not under any pane's shell.
    const result = attributeServers({ servers, parents, ownRoots: new Set([100, 400]), otherRoots: new Set([200]), mentioned: new Set() });
    expect(result.map(entry => entry.port)).toEqual([3000, 8080]);
  });

  it("returns nothing for a session with no servers of its own", () => {
    const result = attributeServers({ servers, parents, ownRoots: new Set([900]), otherRoots: new Set([100, 200]), mentioned: new Set([4000]) });
    expect(result).toEqual([]);
  });

  it("reads loopback ports from transcript text in every common spelling", () => {
    const text = [
      "Local:   http://localhost:5173/", "Server listening on 127.0.0.1:8000",
      "bound to 0.0.0.0:8080 and [::1]:4000", "https://example.com:443/ is not local", "port 99999 is out of range localhost:99999",
    ].join("\n");
    expect([...mentionedPorts(text)].sort((a, b) => a - b)).toEqual([4000, 5173, 8000, 8080]);
  });

  it("stops at launchd and follows the tree only upward", () => {
    expect(descendsFrom(121, new Set([100]), parents)).toBe(true);
    expect(descendsFrom(300, new Set([100]), parents)).toBe(false);
    expect(descendsFrom(100, new Set([121]), parents)).toBe(false);
    expect(descendsFrom(undefined, new Set([100]), parents)).toBe(false);
  });
});
