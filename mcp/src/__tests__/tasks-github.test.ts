import { describe, expect, it } from "vitest";
import { buildTaskIssueBody, extractGithubRepoFromText, parseGithubIssueUrl } from "../tasks-github.js";

describe("tasks-github helpers", () => {
  it("parses GitHub issue URLs into repo and issue number", () => {
    expect(parseGithubIssueUrl("https://github.com/alaarab/phren/issues/14")).toEqual({
      repo: "alaarab/phren",
      issueNumber: 14,
      url: "https://github.com/alaarab/phren/issues/14",
    });
  });

  it("extracts a GitHub repo from markdown text", () => {
    expect(extractGithubRepoFromText("Repo: https://github.com/alaarab/phren\n")).toBe("alaarab/phren");
  });

  it("builds an issue body from task item context", () => {
    const body = buildTaskIssueBody("phren", {
      id: "Q1",
      stableId: "deadbeef",
      section: "Queue",
      line: "Ship GitHub issue linkage [high]",
      checked: false,
      context: "Need optional issue linkage for task items",
      githubIssue: undefined,
      githubUrl: undefined,
    });
    expect(body).toContain("Ship GitHub issue linkage");
    expect(body).toContain("Need optional issue linkage");
    expect(body).toContain("bid:deadbeef");
  });
});
