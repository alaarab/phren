import { describe, expect, it } from "vitest";
import { buildBacklogIssueBody, extractGithubRepoFromText, parseGithubIssueUrl } from "../backlog-github.js";

describe("backlog-github helpers", () => {
  it("parses GitHub issue URLs into repo and issue number", () => {
    expect(parseGithubIssueUrl("https://github.com/alaarab/cortex/issues/14")).toEqual({
      repo: "alaarab/cortex",
      issueNumber: 14,
      url: "https://github.com/alaarab/cortex/issues/14",
    });
  });

  it("extracts a GitHub repo from markdown text", () => {
    expect(extractGithubRepoFromText("Repo: https://github.com/alaarab/cortex\n")).toBe("alaarab/cortex");
  });

  it("builds an issue body from backlog item context", () => {
    const body = buildBacklogIssueBody("cortex", {
      id: "Q1",
      stableId: "deadbeef",
      section: "Queue",
      line: "Ship GitHub issue linkage [high]",
      checked: false,
      context: "Need optional issue linkage for backlog items",
      githubIssue: undefined,
      githubUrl: undefined,
    });
    expect(body).toContain("Ship GitHub issue linkage");
    expect(body).toContain("Need optional issue linkage");
    expect(body).toContain("bid:deadbeef");
  });
});
