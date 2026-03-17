import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../mcp-skills.js";
import type { McpContext } from "../mcp-types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("mcp-skills", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-skills-");
    grantAdmin(tmp.path);
    server = makeMockServer();
    fs.mkdirSync(path.join(tmp.path, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "profiles", "work.yaml"), "name: work\nprojects:\n  - demo\n");
    fs.mkdirSync(path.join(tmp.path, "demo", "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.path, "demo", "skills", "helper.md"),
      "---\nname: helper\ndescription: test helper\n---\nbody\n"
    );

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "work",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    tmp.cleanup();
  });

  it("lists enabled state for skills", async () => {
    const res = parseResult(await server.call("list_skills", { project: "demo" }));
    expect(res.ok).toBe(true);
    expect(res.data.skills[0].name).toBe("helper");
    expect(res.data.skills[0].enabled).toBe(true);
  });

  it("disables and re-enables a skill without deleting it", async () => {
    let res = parseResult(await server.call("disable_skill", { project: "demo", name: "helper" }));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp.path, "demo", "skills", "helper.md"))).toBe(true);

    res = parseResult(await server.call("list_skills", { project: "demo" }));
    expect(res.data.skills[0].enabled).toBe(false);

    res = parseResult(await server.call("enable_skill", { project: "demo", name: "helper" }));
    expect(res.ok).toBe(true);

    res = parseResult(await server.call("list_skills", { project: "demo" }));
    expect(res.data.skills[0].enabled).toBe(true);
  });

  it("includes inherited global skills in project resolution", async () => {
    fs.mkdirSync(path.join(tmp.path, "global", "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.path, "global", "skills", "humanize.md"),
      "---\nname: humanize\ndescription: global helper\n---\nbody\n"
    );

    const res = parseResult(await server.call("list_skills", { project: "demo" }));
    expect(res.ok).toBe(true);
    expect(res.data.skills.some((skill: { name: string; source: string }) => skill.name === "humanize" && skill.source === "global")).toBe(true);
  });

  it("writes project skills into the canonical project skills directory", async () => {
    const res = parseResult(await server.call("write_skill", {
      name: "local-review",
      scope: "demo",
      content: "---\nname: local-review\ndescription: local review helper\n---\nbody\n",
    }));

    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp.path, "demo", "skills", "local-review.md"))).toBe(true);
  });

  it("write_skill rejects a skill name containing path traversal sequences", async () => {
    const res = parseResult(await server.call("write_skill", {
      name: "../../../etc/passwd",
      scope: "demo",
      content: "---\nname: evil\ndescription: path traversal attempt\n---\nevil\n",
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid skill name");
  });

  it("write_skill rejects an invalid scope containing path traversal", async () => {
    const res = parseResult(await server.call("write_skill", {
      name: "myskill",
      scope: "../escape",
      content: "---\nname: myskill\ndescription: test\n---\nbody\n",
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid scope");
  });

  it("read_skill ignores symlinked skill files that point outside the phren store", async () => {
    const outsideDir = makeTempDir("mcp-skills-outside-");
    try {
      const outsideFile = path.join(outsideDir.path, "secret.md");
      fs.writeFileSync(outsideFile, "---\nname: secret\n---\nsecret\n");
      fs.symlinkSync(outsideFile, path.join(tmp.path, "demo", "skills", "secret.md"), process.platform === "win32" ? "file" : undefined);

      const res = parseResult(await server.call("read_skill", { project: "demo", name: "secret" }));
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not found");
    } finally {
      outsideDir.cleanup();
    }
  });

  it("write_skill rejects symlinked skill paths that point outside the phren store", async () => {
    const outsideDir = makeTempDir("mcp-skills-write-escape-");
    try {
      const outsideFile = path.join(outsideDir.path, "linked.md");
      fs.writeFileSync(outsideFile, "outside\n");
      fs.symlinkSync(outsideFile, path.join(tmp.path, "demo", "skills", "linked.md"), process.platform === "win32" ? "file" : undefined);

      const res = parseResult(await server.call("write_skill", {
        name: "linked",
        scope: "demo",
        content: "---\nname: linked\ndescription: blocked\n---\nbody\n",
      }));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/escapes phren store|symlinked skill path/i);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside\n");
    } finally {
      outsideDir.cleanup();
    }
  });
});
