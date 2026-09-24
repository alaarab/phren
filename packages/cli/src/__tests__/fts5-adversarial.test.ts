import { describe, expect, it } from "vitest";
import { buildRobustFtsQuery } from "../utils.js";

describe("buildRobustFtsQuery: adversarial inputs", () => {
  it("drops a query made only of stop words", () => {
    expect(buildRobustFtsQuery("the a is in of")).toBe("");
  });
});
