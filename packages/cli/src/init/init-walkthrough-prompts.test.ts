import { describe, expect, it } from "vitest";
import inquirer from "inquirer";
import { walkthroughPromptsFrom } from "./init-walkthrough.js";

// Inquirer 13 removed the `list` prompt type (now `select`), and `phren init`
// failed on the first choice. Every type the walkthrough asks for must be one
// the installed Inquirer registers.
describe("the init walkthrough's Inquirer prompts", () => {
  it("asks only for prompt types the installed Inquirer registers", async () => {
    const registered = Object.keys((inquirer.prompt as unknown as { prompts: Record<string, unknown> }).prompts);
    const asked: string[] = [];
    const prompt = async (questions: Array<Record<string, unknown>>) => {
      asked.push(...questions.map((q) => String(q.type)));
      return { value: questions[0].type === "confirm" ? true : "b" };
    };

    const ui = walkthroughPromptsFrom({ default: { prompt } })!;
    await ui.input("Name?");
    await ui.confirm("Sure?");
    const choice = await ui.select("Pick", [{ value: "a", name: "A" }, { value: "b", name: "B" }], "a");

    expect(choice).toBe("b");
    expect(asked).toEqual(["input", "confirm", "select"]);
    for (const type of asked) expect(registered).toContain(type);
  });
});
