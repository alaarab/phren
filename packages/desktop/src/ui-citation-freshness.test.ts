import { describe, expect, it } from "vitest";
import { freshnessNote } from "../ui/citation-freshness.js";

describe("citation freshness", () => {
  it.each([undefined, "current", "unknown"])("keeps %s freshness silent", (state) => {
    expect(freshnessNote(state ? { citationFreshness: { state } } : {})).toBeNull();
  });

  it("names the cited file, abbreviated change, summary and UTC date", () => {
    expect(freshnessNote({
      citationData: { file: "src/router.ts" },
      citationFreshness: { state: "changed", lastCommit: {
        sha: "3f2a9c1abcdef", summary: "Split the router into per-host modules", authoredAt: "2026-10-14T00:01:00Z",
      } },
    })).toEqual({ label: "May be out of date", detail: "src/router.ts changed in 3f2a9c1 “Split the router into per-host modules” (Oct 14)" });
  });

  it.each([null, undefined])("reads a raw citation and falls back without lastCommit %s", (lastCommit) => {
    expect(freshnessNote({
      citation: '<!-- phren:cite {"file":"src/router.ts","commit":"abc1234"} -->',
      citationFreshness: { state: "changed", lastCommit },
    })).toEqual({ label: "May be out of date", detail: "src/router.ts changed since this was written" });
  });

  it("handles an unavailable citation without failing the finding render", () => {
    expect(freshnessNote({ citation: "<!-- phren:cite {broken} -->", citationFreshness: { state: "changed" } }))
      .toEqual({ label: "May be out of date", detail: "Cited file changed since this was written" });
  });
});
