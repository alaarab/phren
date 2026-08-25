import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildBwrapArgv,
  wrapWithSandbox,
  classifySandboxDenial,
  parseSandboxMode,
  isBwrapAvailable,
  _resetSandboxProbe,
  SandboxRequiredError,
} from "../permissions/kernel-sandbox.js";
import { createShellTool } from "../tools/shell.js";
import { isPrivateAddress, checkUrlSafety } from "../tools/web-fetch.js";
import type { PermissionConfig } from "../permissions/types.js";

describe("kernel-sandbox", () => {
  beforeEach(() => _resetSandboxProbe());
  afterEach(() => _resetSandboxProbe());

  describe("parseSandboxMode", () => {
    it("accepts the three modes, rejects everything else", () => {
      expect(parseSandboxMode("off")).toBe("off");
      expect(parseSandboxMode("auto")).toBe("auto");
      expect(parseSandboxMode("require")).toBe("require");
      expect(parseSandboxMode("yes")).toBeNull();
      expect(parseSandboxMode(undefined)).toBeNull();
    });
  });

  describe("buildBwrapArgv", () => {
    let workDir: string;
    beforeEach(() => {
      workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-")));
    });
    afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

    it("puts ro-bind first, writable binds after, terminator before the command", () => {
      const argv = buildBwrapArgv(["bash", "-c", "echo hi"], [workDir]);
      expect(argv[0]).toBe("bwrap");
      const ro = argv.indexOf("--ro-bind");
      const bind = argv.indexOf("--bind");
      expect(ro).toBeGreaterThan(0);
      expect(bind).toBeGreaterThan(ro); // writable overlays the ro root
      expect(argv).toContain("--die-with-parent");
      expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["bash", "-c", "echo hi"]);
      expect(argv).toContain(workDir);
    });

    it("dedupes identical roots, skips nonexistent paths and the exact /tmp", () => {
      const argv = buildBwrapArgv(["true"], [workDir, workDir, "/nonexistent-xyz", "/tmp"]);
      const binds = argv.filter((a) => a === "--bind");
      // workDir once (deduped); /tmp is already the writable tmpfs; nonexistent skipped
      expect(binds).toHaveLength(1);
      expect(argv).not.toContain("/nonexistent-xyz");
    });

    it("binds workspaces under /tmp so the tmpfs does not shadow them", () => {
      // workDir lives under os.tmpdir(); it must still get a bind
      const argv = buildBwrapArgv(["true"], [workDir]);
      expect(argv).toContain(workDir);
    });

    it("resolves symlinked workspace roots to their real path", () => {
      const link = path.join(os.tmpdir(), `sbx-link-${Date.now()}`);
      fs.symlinkSync(workDir, link);
      try {
        const argv = buildBwrapArgv(["true"], [link]);
        expect(argv).toContain(workDir);
        expect(argv).not.toContain(link);
      } finally {
        fs.unlinkSync(link);
      }
    });
  });

  describe("wrapWithSandbox", () => {
    it("off mode passes through untouched", () => {
      const decision = wrapWithSandbox(["bash", "-c", "x"], { mode: "off", workspaceRoot: "/w" });
      expect(decision).toEqual({ argv: ["bash", "-c", "x"], sandboxed: false });
    });

    it("auto without bwrap degrades unconfined with a one-time notice", () => {
      if (isBwrapAvailable()) return; // environment actually has bwrap — covered by the live test
      const first = wrapWithSandbox(["bash", "-c", "x"], { mode: "auto", workspaceRoot: "/w" });
      expect(first.sandboxed).toBe(false);
      expect(first.notice).toContain("unconfined");
      const second = wrapWithSandbox(["bash", "-c", "x"], { mode: "auto", workspaceRoot: "/w" });
      expect(second.notice).toBeUndefined();
    });

    it("require without bwrap fails closed", () => {
      if (isBwrapAvailable()) return;
      expect(() => wrapWithSandbox(["bash", "-c", "x"], { mode: "require", workspaceRoot: "/w" }))
        .toThrow(SandboxRequiredError);
    });

    it("wraps with bwrap when available", () => {
      if (!isBwrapAvailable()) return;
      const decision = wrapWithSandbox(["bash", "-c", "x"], { mode: "auto", workspaceRoot: process.cwd() });
      expect(decision.sandboxed).toBe(true);
      expect(decision.argv[0]).toBe("bwrap");
    });
  });

  describe("classifySandboxDenial", () => {
    it("annotates read-only filesystem errors and nothing else", () => {
      expect(classifySandboxDenial("touch: cannot touch '/etc/x': Read-only file system", "/w"))
        .toContain("[sandbox] Write blocked");
      expect(classifySandboxDenial("No such file or directory", "/w")).toBeNull();
      expect(classifySandboxDenial("", "/w")).toBeNull();
    });
  });

  // Live kernel-fence test — only runs where bwrap actually works.
  describe("shell tool under the fence (live bwrap)", () => {
    let workDir: string;
    beforeEach(() => {
      workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-live-")));
    });
    afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

    function permsFor(mode: PermissionConfig["sandboxMode"]): () => PermissionConfig {
      return () => ({ mode: "full-auto", allowedPaths: [], projectRoot: workDir, sandboxMode: mode });
    }

    it("allows workspace writes and blocks outside writes with the [sandbox] marker", async () => {
      if (!isBwrapAvailable()) return;
      const tool = createShellTool(permsFor("require"));

      const inside = await tool.execute(
        { command: `touch ${workDir}/ok.txt && echo wrote`, cwd: workDir },
        undefined,
      );
      expect(inside.is_error).toBeFalsy();
      expect(fs.existsSync(path.join(workDir, "ok.txt"))).toBe(true);

      const outside = await tool.execute(
        { command: "touch /usr/sbx-should-fail 2>&1", cwd: workDir },
        undefined,
      );
      expect(outside.is_error).toBe(true);
      expect(outside.output).toContain("[sandbox] Write blocked");
      expect(fs.existsSync("/usr/sbx-should-fail")).toBe(false);
    });

    it("require mode returns a tool error (not a crash) when bwrap is missing", async () => {
      if (isBwrapAvailable()) return;
      const tool = createShellTool(permsFor("require"));
      const result = await tool.execute({ command: "echo hi" }, undefined);
      expect(result.is_error).toBe(true);
      expect(result.output).toContain("--sandbox require");
    });
  });
});

// ── web_fetch SSRF guard ─────────────────────────────────────────────────────

describe("web_fetch SSRF guard", () => {
  it("classifies private/loopback/link-local/CGNAT/v6 addresses", () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("blocks literal private IPs, local hostnames, and non-http schemes", async () => {
    expect(await checkUrlSafety("http://169.254.169.254/latest/meta-data/")).toContain("Blocked");
    expect(await checkUrlSafety("http://127.0.0.1:8080/admin")).toContain("Blocked");
    expect(await checkUrlSafety("http://localhost/x")).toContain("Blocked");
    expect(await checkUrlSafety("http://foo.internal/x")).toContain("Blocked");
    expect(await checkUrlSafety("file:///etc/passwd")).toContain("Only http/https");
    expect(await checkUrlSafety("not a url")).toContain("Invalid URL");
  });

  it("the override env variable disables the guard", async () => {
    process.env.PHREN_AGENT_ALLOW_PRIVATE_FETCH = "1";
    try {
      expect(await checkUrlSafety("http://127.0.0.1/x")).toBeNull();
    } finally {
      delete process.env.PHREN_AGENT_ALLOW_PRIVATE_FETCH;
    }
  });
});
