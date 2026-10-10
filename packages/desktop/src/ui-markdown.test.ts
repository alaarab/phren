// @ts-expect-error markdown.js is plain JavaScript without type declarations
import { parseInline, parseMarkdown } from "../ui/chat/markdown.js";
import { describe, expect, it } from "vitest";

describe("parseMarkdown blocks", () => {
  it("splits paragraphs on blank lines and keeps soft line breaks", () => {
    const nodes = parseMarkdown("first line\nsecond line\n\nnext");
    expect(nodes.map((n: any) => n.type)).toEqual(["paragraph", "paragraph"]);
    expect(nodes[0].children[0]).toEqual({ type: "text", text: "first line\nsecond line" });
    expect(nodes[1].children[0]).toEqual({ type: "text", text: "next" });
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });

  it("reads heading levels", () => {
    const nodes = parseMarkdown("# One\n### Three");
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ type: "heading", level: 1 });
    expect(nodes[1]).toMatchObject({ type: "heading", level: 3 });
    expect(nodes[0].children[0]).toEqual({ type: "text", text: "One" });
  });

  it("groups consecutive unordered list items", () => {
    const nodes = parseMarkdown("- one\n- two");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("list");
    expect(nodes[0].ordered).toBe(false);
    expect(nodes[0].items).toEqual([
      [{ type: "text", text: "one" }],
      [{ type: "text", text: "two" }],
    ]);
  });

  it("marks ordered lists and splits them from bullets", () => {
    const nodes = parseMarkdown("1. first\n2. second\n\n- bullet");
    expect(nodes.map((n: any) => n.type)).toEqual(["list", "list"]);
    expect(nodes[0].ordered).toBe(true);
    expect(nodes[0].items).toHaveLength(2);
    expect(nodes[1].ordered).toBe(false);
  });

  it("keeps a fenced block's language and text verbatim", () => {
    const nodes = parseMarkdown("```js\nconst a = 1;\n\nconst b = 2;\n```");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual({ type: "code", language: "js", text: "const a = 1;\n\nconst b = 2;" });
  });

  it("reads a fence with no language", () => {
    expect(parseMarkdown("```\nplain\n```")).toEqual([{ type: "code", language: null, text: "plain" }]);
  });

  it("reads a pipe table with a divider and pads short rows", () => {
    const nodes = parseMarkdown("| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Bob |");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("table");
    const header = nodes[0].header.map((cell: any) => cell[0].text);
    expect(header).toEqual(["Name", "Age"]);
    expect(nodes[0].rows).toHaveLength(2);
    expect(nodes[0].rows[1].map((cell: any) => cell[0]?.text ?? "")).toEqual(["Bob", ""]);
  });

  it("does not treat a lone pipe line as a table", () => {
    const nodes = parseMarkdown("| not a table");
    expect(nodes[0].type).toBe("paragraph");
  });
});

describe("parseInline", () => {
  it("reads code spans", () => {
    expect(parseInline("a `b*c` d")).toEqual([
      { type: "text", text: "a " },
      { type: "code", text: "b*c" },
      { type: "text", text: " d" },
    ]);
  });

  it("reads bold and italic", () => {
    const [bold] = parseInline("**bold**");
    expect(bold.type).toBe("strong");
    expect(bold.children).toEqual([{ type: "text", text: "bold" }]);
    const [em] = parseInline("*it*");
    expect(em.type).toBe("em");
  });

  it("does not emphasize intra-word underscores", () => {
    expect(parseInline("a_b_c")).toEqual([{ type: "text", text: "a_b_c" }]);
  });

  it("does not emphasize across spaced asterisks", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
  });

  it("reads links and nests emphasis inside them", () => {
    const [link] = parseInline("[**docs**](https://example.com/x)");
    expect(link).toMatchObject({ type: "link", href: "https://example.com/x" });
    expect(link.children[0]).toMatchObject({ type: "strong" });
  });

  it("leaves a bare bracket as text", () => {
    expect(parseInline("see [note] here")).toEqual([{ type: "text", text: "see [note] here" }]);
  });
});
