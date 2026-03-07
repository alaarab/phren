/**
 * Shell entry point: wires CortexShell to stdin/stdout.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import { CortexShell } from "./shell.js";
import { style, clearScreen, clearToEnd } from "./shell-render.js";

export async function startShell(cortexPath: string, profile: string): Promise<void> {
  const shell = new CortexShell(cortexPath, profile);

  if (!process.stdin.isTTY) {
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const repaint = async () => { clearScreen(); process.stdout.write(await shell.render()); rl.setPrompt(`\n${style.boldCyan(":cortex>")} `); rl.prompt(); };
    await repaint();
    rl.on("line", async (line) => {
      try { const keep = await shell.handleInput(line); if (!keep) { shell.close(); rl.close(); return; } }
      catch (err: unknown) { process.stdout.write(`\n${style.red("Error:")} ${String(err instanceof Error ? err.message : String(err))}\n`); }
      await repaint();
    });
    rl.on("SIGINT", () => { shell.close(); rl.close(); });
    await new Promise<void>((resolve) => { rl.on("close", () => { shell.close(); resolve(); }); });
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?1049h");
  let exiting = false;
  const repaint = async () => { clearScreen(); process.stdout.write(await shell.render()); clearToEnd(); };
  await repaint();
  const onData = async (key: string) => {
    if (exiting) return;
    try {
      const keep = await shell.handleRawKey(key);
      if (!keep) { exiting = true; process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData); shell.close(); process.stdout.write("\x1b[?1049l"); done(); return; }
      await repaint();
    } catch (err: unknown) { shell.setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`); await repaint(); }
  };
  let done: () => void;
  const exitPromise = new Promise<void>((resolve) => { done = resolve; });
  process.stdin.on("data", onData);
  process.stdout.on("resize", async () => { if (!exiting) await repaint(); });
  await exitPromise;
}
