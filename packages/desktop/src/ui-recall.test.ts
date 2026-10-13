import { describe, expect, it } from "vitest";
import { recallHits, recallQuery, withRecall } from "../ui/chat/recall.js";

describe("composer recall", () => {
  it("searches a prompt of three words or more, never a slash command", () => {
    expect(recallQuery("fix login")).toBe("");
    expect(recallQuery("/model opus please now")).toBe("");
    expect(recallQuery("  fix the login redirect  ")).toBe("fix the login redirect");
  });

  it("shows up to three confident hits the prompt does not already carry", () => {
    const hit = (text: string, score: number) => ({ kind: "finding", text, score });
    const results = [hit("Login redirects drop the session cookie", 0.9), hit("Weak match", 0.1), hit("A", 0.5), hit("B", 0.5), hit("C", 0.5)];
    expect(recallHits(results, "fix the login redirect").map((h) => h.text)).toEqual(["Login redirects drop the session cookie", "A", "B"]);
    const attached = withRecall("fix the login redirect ", "Login redirects drop the session cookie");
    expect(attached).toBe("fix the login redirect\n\nPhren remembers: Login redirects drop the session cookie");
    expect(recallHits(results, attached).map((h) => h.text)).toEqual(["A", "B", "C"]);
  });
});
