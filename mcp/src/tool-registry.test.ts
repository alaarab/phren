import { describe, expect, it } from "vitest";
import { getRegisteredTools, getToolCount, renderToolCatalogMarkdown } from "./tool-registry.js";

describe("tool registry", () => {
  it("extracts the live MCP tool inventory from registerTool calls", () => {
    const tools = getRegisteredTools();
    expect(tools.length).toBe(60);
    expect(tools.some((tool) => tool.name === "link_task_issue")).toBe(true);
    expect(tools.some((tool) => tool.name === "promote_task_to_issue")).toBe(true);
    expect(tools.some((tool) => tool.name === "remove_task")).toBe(true);
  });

  it("renders grouped markdown for cortex.SKILL.md", () => {
    expect(getToolCount()).toBe(60);
    const markdown = renderToolCatalogMarkdown();
    expect(markdown).toContain("**Search and browse:**");
    expect(markdown).toContain("`search_knowledge`");
    expect(markdown).toContain("`add_project`");
  });
});
