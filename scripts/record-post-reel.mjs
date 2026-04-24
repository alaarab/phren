#!/usr/bin/env node
// Render docs/motion-lab/post-reel.html into mp4 + gif for the LinkedIn post.
//
// Usage:
//   node scripts/record-post-reel.mjs
//   node scripts/record-post-reel.mjs --fps=30 --duration=20 --width=1080 --height=1080
//   node scripts/record-post-reel.mjs --portrait    (1080x1350, the LinkedIn portrait sweet spot)
//
// Requires:
//   - playwright chromium  (already in workspace devDeps; first run: `pnpm exec playwright install chromium`)
//   - ffmpeg on PATH       (brew install ffmpeg / apt install ffmpeg)
//
// Output: dist/post-reel/post-reel.mp4, dist/post-reel/post-reel.gif

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const PAGE = path.join(REPO, "docs/motion-lab/post-reel.html");
const OUT = path.join(REPO, "dist/post-reel");
const FRAMES = path.join(OUT, "frames");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const FPS = parseInt(args.fps || "30", 10);
const DURATION = parseFloat(args.duration || "20");
let W = parseInt(args.width || "1080", 10);
let H = parseInt(args.height || "1080", 10);
if (args.portrait) { W = 1080; H = 1350; }
const TOTAL_FRAMES = Math.round(FPS * DURATION);

console.log(`recording ${W}x${H} @ ${FPS}fps for ${DURATION}s = ${TOTAL_FRAMES} frames`);

if (!existsSync(PAGE)) {
  console.error(`page not found: ${PAGE}`);
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    console.error("playwright not available. install chromium: pnpm exec playwright install chromium");
    process.exit(1);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

const browser = await chromium.launch({
  args: ["--font-render-hinting=none", "--force-color-profile=srgb", "--hide-scrollbars"],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  reducedMotion: "no-preference",
});
const page = await context.newPage();

try {
  const url = pathToFileURL(PAGE).href + `?record=1&fps=${FPS}&duration=${DURATION}`;
  console.log(`loading ${url}`);
  await page.goto(url, { waitUntil: "networkidle" });

  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

  // Let webfonts settle.
  await page.waitForTimeout(800);

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const t = f / FPS;
    await page.evaluate((tt) => window.__seekTo(tt), t);
    await page.waitForTimeout(8); // settle css transitions
    const file = path.join(FRAMES, `f_${String(f).padStart(5, "0")}.png`);
    await page.screenshot({ path: file, type: "png", clip: { x: 0, y: 0, width: W, height: H } });
    if (f % 30 === 0) process.stdout.write(`\r  frame ${f}/${TOTAL_FRAMES}`);
  }
  process.stdout.write(`\r  frame ${TOTAL_FRAMES}/${TOTAL_FRAMES}\n`);
} finally {
  await context.close();
  await browser.close();
}

console.log("encoding mp4...");
await run("ffmpeg", [
  "-y",
  "-framerate", String(FPS),
  "-i", path.join(FRAMES, "f_%05d.png"),
  "-c:v", "libx264",
  "-preset", "slow",
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  path.join(OUT, "post-reel.mp4"),
]);

const gifFps = Math.min(FPS, 24);
const gifWidth = 720;

console.log("building gif palette...");
const palette = path.join(OUT, "palette.png");
await run("ffmpeg", [
  "-y",
  "-i", path.join(FRAMES, "f_%05d.png"),
  "-vf", `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos,palettegen=stats_mode=full`,
  palette,
]);

console.log("encoding gif...");
await run("ffmpeg", [
  "-y",
  "-framerate", String(FPS),
  "-i", path.join(FRAMES, "f_%05d.png"),
  "-i", palette,
  "-lavfi", `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
  "-loop", "0",
  path.join(OUT, "post-reel.gif"),
]);

console.log("\ndone:");
console.log(" ", path.relative(REPO, path.join(OUT, "post-reel.mp4")));
console.log(" ", path.relative(REPO, path.join(OUT, "post-reel.gif")));
console.log("\ntip: linkedin prefers mp4 in the feed (better quality, autoplays muted).");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}
