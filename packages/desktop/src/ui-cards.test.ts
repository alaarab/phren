import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Plain ESM UI module.
import { renderInteractions } from "../ui/chat/cards.js";

// Only the DOM operations used to build a question card; browser tests own
// focus, input events and submission through the session's live status stream.
class Element extends EventTarget {
  children: Element[] = [];
  className = "";
  textContent = "";
  dataset = {};
  classList = { add() {}, toggle() {} };
  append(...nodes: Element[]) { this.children.push(...nodes); }
  appendChild(node: Element) { this.append(node); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  get text(): string { return this.textContent + this.children.map((node) => node.text).join(""); }
}

afterEach(() => vi.unstubAllGlobals());

describe("question cards from Hook status", () => {
  it.each(["claude", "opencode", "codex"])("renders %s questions from their status channel", (source) => {
    vi.stubGlobal("document", {
      head: new Element(),
      createElement: () => new Element(),
      createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
    });
    const container = new Element();
    const questions = [{ question: "Red or blue?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }];
    const status = source === "codex"
      ? { pendingQuestions: [{ toolUseId: "q1", questions }] }
      : { terminalPrompt: { toolName: "AskUserQuestion", questions, questionIndex: 0 } };
    const handle = renderInteractions(container, status, { computer: "box", target: { source } });
    expect(container.children).toHaveLength(1);
    expect(container.text).toContain("Red or blue?");
    expect(container.text).toContain("RedBlue");
    expect(container.text).toContain("Send answer");
    handle.destroy();
    expect(container.children).toHaveLength(0);
  });
});
