/**
 * Shell entry point: wires CortexShell to stdin/stdout.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import { CortexShell } from "./shell.js";
import { style, clearScreen, clearToEnd, shellStartupFrames } from "./shell-render.js";
import { errorMessage } from "./utils.js";
import { computeCortexLiveStateToken } from "./shared.js";
import { VERSION } from "./init-shared.js";

async function playStartupIntro(): Promise<void> {
  if (!process.stdout.isTTY) return;
  const frames = shellStartupFrames(VERSION);
  for (const frame of frames) {
    clearScreen();
    process.stdout.write(frame);
    clearToEnd();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

export async function startShell(cortexPath: string, profile: string): Promise<void> {
  const shell = new CortexShell(cortexPath, profile);
  let liveStateToken = computeCortexLiveStateToken(cortexPath);

  if (!process.stdin.isTTY) {
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const repaint = async () => { clearScreen(); process.stdout.write(await shell.render()); rl.setPrompt(`\n${style.boldCyan(":cortex>")} `); rl.prompt(); };
    const poll = setInterval(async () => {
      const nextToken = computeCortexLiveStateToken(cortexPath);
      if (nextToken === liveStateToken) return;
      liveStateToken = nextToken;
      shell.invalidateSubsectionsCache();
      shell.setMessage(`  ${style.boldCyan("Live")} ${style.dim("store updated")}`);
      await repaint();
    }, 2000);
    await repaint();
    rl.on("line", async (line) => {
      try { const keep = await shell.handleInput(line); if (!keep) { shell.close(); rl.close(); return; } }
      catch (err: unknown) { process.stdout.write(`\n${style.red("Error:")} ${String(errorMessage(err))}\n`); }
      await repaint();
    });
    rl.on("SIGINT", () => { clearInterval(poll); shell.close(); rl.close(); });
    rl.on("close", () => { clearInterval(poll); });
    await new Promise<void>((resolve) => { rl.on("close", () => { shell.close(); resolve(); }); });
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?1049h");
  let exiting = false;
  const repaint = async () => { clearScreen(); process.stdout.write(await shell.render()); clearToEnd(); };
  await playStartupIntro();
  const poll = setInterval(async () => {
    if (exiting) return;
    const nextToken = computeCortexLiveStateToken(cortexPath);
    if (nextToken === liveStateToken) return;
    liveStateToken = nextToken;
    shell.invalidateSubsectionsCache();
    shell.setMessage(`  ${style.boldCyan("Live")} ${style.dim("store updated")}`);
    await repaint();
  }, 2000);
  await repaint();
  const onData = async (key: string) => {
    if (exiting) return;
    try {
      const keep = await shell.handleRawKey(key);
      if (!keep) { exiting = true; clearInterval(poll); process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData); shell.close(); process.stdout.write("\x1b[?1049l"); done(); return; }
      await repaint();
    } catch (err: unknown) { shell.setMessage(`Error: ${errorMessage(err)}`); await repaint(); }
  };
  let done: () => void;
  const exitPromise = new Promise<void>((resolve) => { done = resolve; });
  process.stdin.on("data", onData);
  process.stdout.on("resize", async () => { if (!exiting) await repaint(); });
  await exitPromise;
}
