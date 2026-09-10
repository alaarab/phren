import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { userInfo } from "node:os";
import { BridgeError, type Json } from "./protocol.js";

const exec = promisify(execFile);
export async function repositoryDiff(cwd: string): Promise<Json> {
  const git = async (...args: string[]) => (await exec("git", ["-C", cwd, "--no-pager", ...args], {
    timeout: 10_000, maxBuffer: 4_194_304, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout;
  let root: string;
  try { root = (await git("rev-parse", "--show-toplevel")).trim(); }
  catch { throw new BridgeError(409, "This pane is not in a Git repository."); }
  const branch = (await git("branch", "--show-current")).trim();
  const status = (await git("status", "--porcelain=v1", "-z", "--untracked-files=normal")).split("\0");
  const files: Json[] = [];
  for (let index = 0; index < status.length && files.length < 500; index++) {
    const record = status[index]; if (!record) continue;
    const code = record.slice(0, 2), file = record.slice(3);
    if (/[RC]/.test(code)) index++; // porcelain -z carries a second pathname.
    const sections: Json[] = [];
    for (const [kind, staged] of [["staged", true], ["unstaged", false]] as const) {
      if (code === "??") continue;
      const patch = await git("diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", file);
      if (patch) sections.push({ id: `${kind}:${file}`, kind, binary: patch.includes("Binary files"), loadState: "loaded", patch });
    }
    files.push({ path: file, status: code, sections });
  }
  return { branch, root, launchPath: cwd, files };
}

export interface LocalServer { name: string; port: number; origin: string; process?: string; pid?: number }
function probe(port: number, host: string): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: string | null) => { if (!settled) { settled = true; resolve(value); } };
    const req = request({ hostname: host, port, path: "/", method: "GET", timeout: 1200, headers: { Host: `localhost:${port}` } }, res => {
      let body = "";
      res.on("data", data => { body += data.toString(); if (body.length > 32_768) res.destroy(); });
      const end = () => finish(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(body)?.[1]?.trim() || `Web server on port ${port}`);
      res.on("end", end); res.on("close", end); res.on("error", () => finish(null));
    });
    req.on("error", () => finish(null)); req.on("timeout", () => { req.destroy(); finish(null); }); req.end();
  });
}
export async function webServers(): Promise<LocalServer[]> {
  const result = await exec(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
    ["-nP", "-a", "-u", userInfo().username, "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 4000, maxBuffer: 1_048_576 }).catch(() => ({ stdout: "" }));
  let pid: number | undefined, processName: string | undefined;
  const ports = new Map<string, LocalServer>();
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("c")) processName = line.slice(1);
    if (!line.startsWith("n")) continue;
    const match = /^(?:n)(\*|127\.0\.0\.1|localhost|0\.0\.0\.0|\[::\]|\[::1\]):(\d+)$/.exec(line);
    if (!match) continue;
    const port = Number(match[2]); const host = match[1].includes(":") ? "[::1]" : "127.0.0.1";
    ports.set(`${host}:${port}`, { name: "", port, origin: `http://${host}:${port}`, process: processName, pid });
  }
  const candidates = [...ports.values()].slice(0, 64);
  const found: LocalServer[] = [];
  for (let i = 0; i < candidates.length; i += 8) {
    await Promise.all(candidates.slice(i, i + 8).map(async server => {
      const name = await probe(server.port, server.origin.includes("[::1]") ? "::1" : "127.0.0.1");
      if (name !== null) found.push({ ...server, name });
    }));
  }
  return found.sort((a, b) => a.port - b.port);
}
