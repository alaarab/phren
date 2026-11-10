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

  it("nests an indented list under the item above it", () => {
    const [list] = parseMarkdown("- parent\n  - child a\n  - child b\n    1. deep\n- sibling");
    expect(list.items.map(text)).toEqual(["parent", "sibling"]);
    const [children] = list.nested[0];
    expect(children.items.map(text)).toEqual(["child a", "child b"]);
    expect(children.nested[1][0]).toMatchObject({ type: "list", ordered: true });
    expect(list.nested[1]).toEqual([]);
  });

  it("keeps a numbered list's count across a code block written between its steps", () => {
    const nodes = parseMarkdown("1. install\n```sh\nnpm i\n```\n2. build\n3. ship");
    expect(nodes.map((n: any) => n.type)).toEqual(["list", "code", "list"]);
    expect(nodes[0].start).toBe(1);
    expect(nodes[2].start).toBe(2);
    expect(nodes[2].items.map(text)).toEqual(["build", "ship"]);
  });

  it("keeps a code block and a paragraph indented under an item inside that item", () => {
    const [list] = parseMarkdown("1. step\n   ```ts\n   const a = 1;\n   ```\n   and then\n2. next");
    expect(list.items.map(text)).toEqual(["step", "next"]);
    expect(list.nested[0]).toEqual([
      { type: "code", language: "ts", text: "const a = 1;" },
      { type: "paragraph", children: [{ type: "text", text: "and then" }] },
    ]);
  });

  it("keeps one list when blank lines separate its items", () => {
    const nodes = parseMarkdown("1. first\n\n2. second\n\nafter");
    expect(nodes.map((n: any) => n.type)).toEqual(["list", "paragraph"]);
    expect(nodes[0].items).toHaveLength(2);
  });

  it("reads task list boxes", () => {
    const [list] = parseMarkdown("- [ ] todo\n- [x] done\n- plain");
    expect(list.checked).toEqual([false, true, null]);
    expect(list.items.map(text)).toEqual(["todo", "done", "plain"]);
  });

  it("reads a quote and what is inside it", () => {
    const [quote, after] = parseMarkdown("> first **bold**\n> - item\n\nafter");
    expect(quote.type).toBe("quote");
    expect(quote.children.map((n: any) => n.type)).toEqual(["paragraph", "list"]);
    expect(after.type).toBe("paragraph");
  });

  it("reads a rule, and not a bullet, from a line of dashes", () => {
    expect(parseMarkdown("above\n\n---\n\nbelow").map((n: any) => n.type)).toEqual(["paragraph", "rule", "paragraph"]);
  });

  it("closes a fence only on a fence at least as long with nothing after it", () => {
    const [code, rest] = parseMarkdown("````md\n```ts\ninner\n```\n````\nafter");
    expect(code).toEqual({ type: "code", language: "md", text: "```ts\ninner\n```" });
    expect(rest.type).toBe("paragraph");
  });
});

/** An inline run back as text, with each span named: `<em>x</em>`. */
function spans(nodes: any[]): string {
  return nodes.map((n) => n.type === "text" ? n.text
    : `<${n.type}${n.href ? ` ${n.href}` : ""}>${n.children ? spans(n.children) : n.text}</${n.type}>`).join("");
}
const text = (inline: any[]) => spans(inline);

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

  it.each([
    // Emphasis that is followed by a space, which is nearly all of it.
    ["Restore the token *before* the guard runs.", "Restore the token <em>before</em> the guard runs."],
    ["use _private_ here", "use <em>private</em> here"],
    ["***both***", "<strong><em>both</em></strong>"],
    ["~~gone~~ kept", "<del>gone</del> kept"],
    // Markers that are not emphasis stay as written.
    ["*args and **kwargs", "*args and **kwargs"],
    ["glob src/**/*.ts and *.js files", "glob src/**/*.ts and *.js files"],
    ["__init__ and __main__", "__init__ and __main__"],
    ["2*3*4", "2*3*4"],
    ["\\*not emphasis\\*", "*not emphasis*"],
    // Links, written and bare.
    ["see [a] and [b](https://u.dev)", "see [a] and <link https://u.dev>b</link>"],
    ["wiki [x](https://w.org/A_(b))", "wiki <link https://w.org/A_(b)>x</link>"],
    ["PR at https://git.example.com/pull/12. Done", "PR at <link https://git.example.com/pull/12>https://git.example.com/pull/12</link>. Done"],
    ["(https://x.dev/p)", "(<link https://x.dev/p>https://x.dev/p</link>)"],
    ["**https://x.dev/r**", "<strong><link https://x.dev/r>https://x.dev/r</link></strong>"],
    ["<https://x.dev/q>", "<link https://x.dev/q>https://x.dev/q</link>"],
    // Code spans.
    ["`` a ` b `` and `c`", "<code>a ` b</code> and <code>c</code>"],
  ])("reads %j", (source, expected) => {
    expect(spans(parseInline(source))).toBe(expected);
  });
});

describe("a reply still arriving", () => {
  const partial = (source: string) => spans(parseInline(source, { partial: true }));

  it.each([
    // A span whose end has not arrived is drawn as if it had, so its markers never show.
    ["now **bol", "now <strong>bol</strong>"],
    ["run `pnpm te", "run <code>pnpm te</code>"],
    ["an *ital", "an <em>ital</em>"],
    ["see [the docs](https://exa", "see the docs"],
    // Half of a closing pair is not drawn as part of the span.
    ["the **guard*", "the <strong>guard</strong>"],
    ["run ``a ` b`", "run <code>a ` b</code>"],
    // A marker with nothing after it yet is not shown at all.
    ["now **", "now "],
    ["run `", "run "],
    // A marker that was never going to be emphasis stays a character.
    ["a * b", "a * b"],
    [`*args and ${"more words ".repeat(14)}`, `*args and ${"more words ".repeat(14)}`],
  ])("draws %j", (source, expected) => {
    expect(partial(source)).toBe(expected);
  });

  it("only treats the last block as unfinished", () => {
    const [first, last] = parseMarkdown("a stray *star\n\nand **bol", { partial: true });
    expect(spans(first.children)).toBe("a stray *star");
    expect(spans(last.children)).toBe("and <strong>bol</strong>");
  });
});

describe("text that is hostile to read", () => {
  // Each input is big enough that a pass rescanning the rest of the text at every marker takes seconds;
  // the budget leaves a loaded CI runner room (a linear pass takes a few milliseconds).
  const BUDGET_MS = 1500;
  it.each([
    ["unclosed emphasis", "*a ".repeat(40_000)],
    ["unclosed bold", "**a ".repeat(30_000)],
    ["open brackets", "[".repeat(100_000)],
    ["mixed backtick runs", "`a ``b ".repeat(15_000)],
    ["a link ending in brackets", `http://a${")".repeat(100_000)}`],
    ["blank lines between items", "- a\n\n\n\n".repeat(10_000)],
  ])("reads %s in linear time", (_name, source) => {
    const started = performance.now();
    parseMarkdown(source, { partial: true });
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
