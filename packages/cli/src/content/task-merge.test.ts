import { describe, expect, it } from "vitest";
import { mergeTask } from "./validate.js";

/**
 * The union merge that reconciles a diverged `tasks.md` during a store pull.
 * Real task lines carry a metadata comment (`<!-- bid:HASH rank:N created:... -->`),
 * and continuation lines such as `Context:` and `GitHub:`.
 */

function doc(active: string[]): string {
  return `# demo tasks\n\n## Active\n\n${active.join("\n")}\n\n## Queue\n\n## Done\n`;
}

describe("mergeTask", () => {
  it("deduplicates the same task by stable ID even when metadata differs", () => {
    const ours = doc(["- [ ] Ship the release <!-- bid:aaaa1111 rank:1 -->"]);
    const theirs = doc(["- [ ] Ship the release <!-- bid:aaaa1111 rank:9 -->"]);
    const merged = mergeTask(ours, theirs);
    expect(merged.match(/Ship the release/g)).toHaveLength(1);
    expect(merged).toContain("bid:aaaa1111");
    expect(merged).not.toContain("<<<<<<<");
  });

  it("keeps every distinct task from both sides", () => {
    const ours = doc(["- [ ] Local task <!-- bid:aaaa1111 rank:1 -->"]);
    const theirs = doc(["- [ ] Remote task <!-- bid:bbbb2222 rank:2 -->"]);
    const merged = mergeTask(ours, theirs);
    expect(merged).toContain("Local task");
    expect(merged).toContain("Remote task");
    expect(merged).toContain("bid:aaaa1111");
    expect(merged).toContain("bid:bbbb2222");
  });

  it("preserves GitHub continuation lines through the merge", () => {
    const ours = doc([
      "- [ ] Track me <!-- bid:aaaa1111 rank:1 -->",
      "  GitHub: #7 https://github.com/acme/demo/issues/7",
    ]);
    const theirs = doc(["- [ ] Other <!-- bid:bbbb2222 rank:2 -->"]);
    const merged = mergeTask(ours, theirs);
    expect(merged).toContain("GitHub: #7 https://github.com/acme/demo/issues/7");
  });

  it("fills in a missing Context line from the other side of the same task", () => {
    const ours = doc(["- [ ] Shared <!-- bid:aaaa1111 rank:1 -->"]);
    const theirs = doc([
      "- [ ] Shared <!-- bid:aaaa1111 rank:1 -->",
      "  Context: discovered on the other computer",
    ]);
    const merged = mergeTask(ours, theirs);
    expect(merged).toContain("Context: discovered on the other computer");
    expect(merged.match(/Shared/g)).toHaveLength(1);
  });

  it("still deduplicates legacy lines that carry no stable ID", () => {
    const ours = doc(["- [ ] Buy milk"]);
    const theirs = doc(["- [ ] Buy milk"]);
    expect(mergeTask(ours, theirs).match(/Buy milk/g)).toHaveLength(1);
  });
});
