import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  _resetSandboxProbe,
  buildBwrapArgv,
  buildSeatbeltProfile,
  classifyNetworkDenial,
  isKernelSandboxAvailable,
  isSeatbeltAvailable,
  wrapWithSandbox,
} from "../permissions/kernel-sandbox.js";
import { createShellTool } from "../tools/shell.js";
import { parseArgs } from "../config.js";
import type { PermissionConfig } from "../permissions/types.js";

afterEach(() => _resetSandboxProbe());

describe("--no-network", () => {
  it("adds a network namespace to bwrap and an outbound-IP deny to Seatbelt, only when asked", () => {
    expect(buildBwrapArgv(["true"], ["/tmp"], { network: false })).toContain("--unshare-net");
    expect(buildBwrapArgv(["true"], ["/tmp"])).not.toContain("--unshare-net");
    expect(buildSeatbeltProfile(["/tmp"], { network: false })).toContain("(deny network-outbound (remote ip))");
    expect(buildSeatbeltProfile(["/tmp"])).not.toContain("network");
  });

  it("is parsed from the command line", () => {
    expect(parseArgs(["--no-network", "task"]).noNetwork).toBe(true);
  });

  it("names a blocked connection", () => {
    expect(classifyNetworkDenial("curl: (6) Could not resolve host: example.com")).toContain("--no-network");
    expect(classifyNetworkDenial("connect EPERM 1.1.1.1:53")).toContain("Network blocked");
    expect(classifyNetworkDenial("TypeError: x is undefined")).toBeNull();
  });

  it("fails closed where no kernel sandbox can isolate the network", () => {
    const canIsolate = isKernelSandboxAvailable() || isSeatbeltAvailable(true);
    const run = () => wrapWithSandbox(["true"], { mode: "off", workspaceRoot: os.tmpdir(), network: false });
    if (canIsolate) expect(run().sandboxed).toBe(true);
    else expect(run).toThrow("--no-network needs a kernel sandbox");
  });

  it.runIf(process.platform === "darwin" && isSeatbeltAvailable(true))("on macOS, a shell command can't connect out, and the agent says why", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nonet-")));
    try {
      const perms: PermissionConfig = { mode: "full-auto", projectRoot: root, allowedPaths: [], sandboxMode: "off", network: "off" };
      const shell = createShellTool(() => perms);
      const connect = `node -e 'require("net").connect(53,"1.1.1.1").on("error",e=>{console.error(e.message);process.exit(1)}).on("connect",()=>process.exit(0))'`;
      const result = await shell.execute({ command: connect, cwd: root });
      expect(result.is_error).toBe(true);
      expect(result.output).toContain("EPERM");
      expect(result.output).toContain("Network blocked");
      // Writing in the workspace still works.
      const write = await shell.execute({ command: "echo ok > out.txt && cat out.txt", cwd: root });
      expect(write.output).toContain("ok");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
