import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "./parser.js";

const FIXTURES = path.join(__dirname, "__fixtures__");
const read = (relative: string): string => fs.readFileSync(path.join(FIXTURES, relative), "utf8");

function symbolsByName(result: Awaited<ReturnType<typeof parseFile>>): Map<string, (typeof result.symbols)[number]> {
  return new Map(result.symbols.map(symbol => [symbol.name, symbol]));
}

describe("code parser", () => {
  it("extracts TypeScript symbols with kinds, signatures and docs", async () => {
    const result = await parseFile("typescript/app.ts", read("typescript/app.ts"));
    expect(result.language).toBe("typescript");
    const byName = symbolsByName(result);
    expect(byName.get("add")).toMatchObject({
      kind: "function",
      signature: "function add(a: number, b: number): number",
      doc: "Adds two numbers.",
      exported: true,
    });
    expect(byName.get("Point")?.kind).toBe("class");
    expect(byName.get("length")).toMatchObject({ kind: "method", parent: "Point", doc: "Distance from the origin." });
    expect(byName.get("Named")?.kind).toBe("interface");
    expect(byName.get("Coordinate")?.kind).toBe("type");
    expect(byName.get("Axis")?.kind).toBe("enum");
  });

  it("extracts Swift symbols", async () => {
    const service = await parseFile("swift/Service.swift", read("swift/Service.swift"));
    expect(service.language).toBe("swift");
    const byName = symbolsByName(service);
    expect(byName.get("computeArea")?.kind).toBe("function");
    expect(byName.get("Rectangle")?.kind).toBe("class");
    expect(byName.get("area")?.kind).toBe("method");

    const model = await parseFile("swift/Model.swift", read("swift/Model.swift"));
    const modelNames = symbolsByName(model);
    expect(modelNames.get("Point")?.kind).toBe("struct");
    expect(modelNames.get("Shape")?.kind).toBe("interface");
    expect(modelNames.get("Axis")?.kind).toBe("enum");
    expect(modelNames.get("Point")?.doc).toBe("A point in the plane.");
  });

  it("extracts Python symbols and docstrings", async () => {
    const result = await parseFile("python/tool.py", read("python/tool.py"));
    expect(result.language).toBe("python");
    const byName = symbolsByName(result);
    expect(byName.get("greet")).toMatchObject({ kind: "function", doc: "Return a greeting for name." });
    expect(byName.get("Greeter")).toMatchObject({ kind: "class", doc: "Greets people by name." });
    expect(byName.get("hello")).toMatchObject({ kind: "method", parent: "Greeter" });
  });

  it("collects references by name, marking calls", async () => {
    const result = await parseFile("typescript/util.ts", read("typescript/util.ts"));
    expect(result.references.some(reference => reference.name === "add" && reference.kind === "call")).toBe(true);
    expect(result.references.some(reference => reference.name === "measure" && reference.kind === "call")).toBe(false);
    expect(result.references.every(reference => reference.line > 0)).toBe(true);
  });

  it("falls back to a line-based outline for languages without a grammar", async () => {
    const result = await parseFile("unknown/notes.custom", read("unknown/notes.custom"));
    expect(result.language).toBe("unknown");
    const names = result.symbols.map(symbol => `${symbol.kind}:${symbol.name}`);
    expect(names).toContain("function:custom_helper");
    expect(names).toContain("class:CustomThing");
    expect(result.references.some(reference => reference.name === "custom_helper")).toBe(true);
  });
});
