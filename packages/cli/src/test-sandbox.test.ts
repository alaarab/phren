import { expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { removeSandboxHome } from "./test-sandbox.js";
import { codexExecutable, CODEX_OFF } from "./bridge/codex-binary.js";

it("stops the codex daemon under the home, kills its leftovers and removes the home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phren-test-home-"));
  const ran: { file: string; args: string[]; home?: string }[] = [], killed: number[] = [];
  removeSandboxHome(home, {
    run: (file, args, env) => { ran.push({ file, args, home: env.HOME }); throw new Error("no codex"); },
    processes: () => [
      { pid: 11, command: `/usr/bin/codex app-server --listen unix://${home}/.codex/app-server.sock --managed-daemon` },
      { pid: 12, command: `codex app-server pid-update-loop ${home}/.codex/daemon.pid` },
      { pid: 13, command: "codex app-server --managed-daemon /tmp/someone-elses-home/.codex" },
      { pid: 14, command: `vim ${home}/notes` },
    ],
    kill: pid => killed.push(pid),
  });
  expect(ran).toEqual([{ file: "codex", args: ["app-server", "daemon", "stop"], home }]);
  expect(killed).toEqual([11, 12]);
  expect(fs.existsSync(home)).toBe(false);
});

it("resolves no codex binary when PHREN_CODEX_BINARY is off, and honors the process env in tests", () => {
  expect(codexExecutable({ PATH: "/usr/bin", PHREN_CODEX_BINARY: "off" })).toBe(CODEX_OFF);
  expect(codexExecutable()).toBe(CODEX_OFF);
});
