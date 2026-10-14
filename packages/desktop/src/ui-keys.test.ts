import { describe, expect, it } from "vitest";
import { shadowedByPrefix } from "../ui/keys.js";

describe("shadowedByPrefix", () => {
  it("lets Herdr's Ctrl+B prefix win over the Cmd+B sidebar default off macOS only", () => {
    expect(shadowedByPrefix("cmd+b", ["ctrl+b"], false)).toBe(true);
    expect(shadowedByPrefix("cmd+b", ["ctrl+b"], true)).toBe(false);
    expect(shadowedByPrefix("cmd+shift+b", ["ctrl+b"], false)).toBe(false);
    expect(shadowedByPrefix("cmd+k", ["ctrl+b"], false)).toBe(false);
    expect(shadowedByPrefix("cmd+a", ["ctrl+a"], false)).toBe(true);
  });
});
