import { describe, expect, it } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { getPersistentVectorIndex } from "../shared/vector-index.js";

function makeVec(seed: number, dims = 16): number[] {
  const vec: number[] = [];
  let value = seed >>> 0;
  for (let i = 0; i < dims; i++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const a = ((value & 0xffff) / 0xffff) * 2 - 1;
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const b = ((value & 0xffff) / 0xffff) * 2 - 1;
    vec.push(a + b * 0.25);
  }
  return vec;
}

describe("PersistentVectorIndex", () => {
  it("returns a bounded candidate set that still includes the exact vector path", () => {
    const tmp = makeTempDir("vector-index-");
    try {
      const entries = Array.from({ length: 96 }, (_, i) => ({
        path: `${tmp.path}/doc-${i}.md`,
        model: "nomic-embed-text",
        vec: makeVec(i + 1),
      }));

      const index = getPersistentVectorIndex(tmp.path);
      index.ensure(entries);

      const target = entries[37];
      const candidates = index.query(target.model, target.vec, 5);

      expect(candidates).toContain(target.path);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThan(entries.length);
    } finally {
      tmp.cleanup();
    }
  });
});
