/**
 * AskUserQuestion tool — structured prompts to the user for decisions.
 *
 * Instead of outputting "should I do X or Y?" as text, this tool presents
 * a structured choice and returns the user's selection.
 */
import * as readline from "node:readline";
import type { AgentTool } from "./types.js";
import { t } from "../theme.js";

export const askUserTool: AgentTool = {
  name: "ask_user",
  description:
    "Ask the user a question when you need clarification or a decision. " +
    "Present clear options when possible. The user's response is returned as the tool result. " +
    "Use this instead of outputting questions as text — it creates a clear interaction point.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of choices. If provided, the user picks one by number.",
      },
      default_option: {
        type: "number",
        description: "0-indexed default option (used if user presses Enter without input).",
      },
    },
    required: ["question"],
  },
  async execute(input) {
    const question = input.question as string;
    const options = (input.options as string[]) || [];
    const defaultIdx = (input.default_option as number) ?? -1;

    // Display the question
    process.stderr.write(`\n${t.brand("?")} ${t.bold(question)}\n`);

    if (options.length > 0) {
      for (let i = 0; i < options.length; i++) {
        const marker = i === defaultIdx ? t.brand(`[${i + 1}]`) : t.dim(`[${i + 1}]`);
        process.stderr.write(`  ${marker} ${options[i]}\n`);
      }
      process.stderr.write(t.muted("  Enter number or type your answer: "));
    } else {
      process.stderr.write(t.muted("  > "));
    }

    // Read user input
    const answer = await readLine();

    if (options.length > 0) {
      const num = parseInt(answer.trim(), 10);
      if (num >= 1 && num <= options.length) {
        return { output: options[num - 1] };
      }
      // If user pressed enter and there's a default
      if (answer.trim() === "" && defaultIdx >= 0 && defaultIdx < options.length) {
        return { output: options[defaultIdx] };
      }
    }

    // Return raw answer (or default if empty)
    if (answer.trim() === "" && defaultIdx >= 0 && options.length > 0) {
      return { output: options[defaultIdx] };
    }

    return { output: answer.trim() || "(no answer)" };
  },
};

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      // If stdin is in raw mode (TUI), temporarily exit it
      const wasRaw = (process.stdin as NodeJS.ReadStream).isRaw;
      if (wasRaw) process.stdin.setRawMode(false);

      const iface = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      iface.question("", (answer) => {
        iface.close();
        if (wasRaw && process.stdin.isTTY) process.stdin.setRawMode(true);
        resolve(answer);
      });
    } else {
      const iface = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      iface.question("", (answer) => {
        iface.close();
        resolve(answer);
      });
    }
  });
}
