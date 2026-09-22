import { expect, it } from "vitest";

it("keeps the iOS graph under 1.5 MB without bundling unused WebGPU", async () => {
  // Load the actual app bundler so target, minification and aliases cannot drift.
  const script = new URL("../../../apps/ios/scripts/bundle-graph.mjs", import.meta.url).href;
  const { bundleGraph } = await import(/* @vite-ignore */ script);
  const result = await bundleGraph(false);
  expect(result.outputFiles[0].contents.byteLength).toBeLessThan(1_500_000);
  expect(Object.keys(result.metafile.inputs).some(file => file.includes("three.webgpu"))).toBe(false);
  expect(Object.keys(result.metafile.inputs).some(file => file.includes("three.module"))).toBe(true);
});
