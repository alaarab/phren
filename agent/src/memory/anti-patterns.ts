/**
 * Anti-pattern tracker: detects failed→succeeded tool pairs
 * and saves them as findings at session end.
 */
import type { PhrenContext } from "./context.js";
import { importCoreFinding } from "../phren-imports.js";

interface ToolAttempt {
  name: string;
  input: string;
  succeeded: boolean;
  output: string;
  timestamp: number;
}

export class AntiPatternTracker {
  private attempts: ToolAttempt[] = [];

  /** Record a tool execution result. */
  recordAttempt(name: string, input: Record<string, unknown>, succeeded: boolean, output: string): void {
    this.attempts.push({
      name,
      input: JSON.stringify(input).slice(0, 300),
      succeeded,
      output: output.slice(0, 300),
      timestamp: Date.now(),
    });
  }

  /**
   * Extract anti-patterns: find cases where a tool failed then later
   * succeeded with different input (same tool name).
   */
  extractAntiPatterns(): Array<{ tool: string; failedInput: string; failedOutput: string; succeededInput: string }> {
    const patterns: Array<{ tool: string; failedInput: string; failedOutput: string; succeededInput: string }> = [];
    const seen = new Set<string>();

    for (let i = 0; i < this.attempts.length; i++) {
      const fail = this.attempts[i];
      if (fail.succeeded) continue;

      // Look for a later success with same tool name
      for (let j = i + 1; j < this.attempts.length; j++) {
        const success = this.attempts[j];
        if (success.name !== fail.name || !success.succeeded) continue;
        if (success.input === fail.input) continue; // Same input, not an anti-pattern

        const key = `${fail.name}:${fail.input}`;
        if (seen.has(key)) break;
        seen.add(key);

        patterns.push({
          tool: fail.name,
          failedInput: fail.input,
          failedOutput: fail.output,
          succeededInput: success.input,
        });
        break;
      }
    }

    return patterns;
  }

  /**
   * Save top 3 anti-patterns as findings at session end.
   */
  async flushAntiPatterns(ctx: PhrenContext): Promise<number> {
    if (!ctx.project) return 0;

    const patterns = this.extractAntiPatterns().slice(0, 3);
    if (patterns.length === 0) return 0;

    let saved = 0;
    try {
      const { addFinding } = await importCoreFinding();
      for (const p of patterns) {
        const finding = `[anti-pattern] ${p.tool}: failed with ${p.failedInput.slice(0, 100)} (${p.failedOutput.slice(0, 80)}), succeeded with ${p.succeededInput.slice(0, 100)}`;
        await addFinding(ctx.phrenPath, ctx.project, finding);
        saved++;
      }
    } catch {
      // best effort
    }

    return saved;
  }
}
