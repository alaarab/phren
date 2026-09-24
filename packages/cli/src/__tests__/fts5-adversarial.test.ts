import { describe, expect, it } from "vitest";
import { sanitizeFts5Query, buildRobustFtsQuery } from "../utils.js";

describe("sanitizeFts5Query: adversarial inputs", () => {
  it("preserves * wildcard operator", () => {
    const result = sanitizeFts5Query("foo*");
    expect(result).toContain("*");
    expect(result).toBe("foo*");
  });

  it("strips braces, brackets, and special chars", () => {
    const result = sanitizeFts5Query("foo {bar} [baz] (qux)");
    expect(result).not.toMatch(/[{}\[\]()]/);
    expect(result).toContain("foo");
  });
});

describe("buildRobustFtsQuery: adversarial inputs", () => {
  it("drops a query made only of stop words", () => {
    expect(buildRobustFtsQuery("the a is in of")).toBe("");
  });
});
