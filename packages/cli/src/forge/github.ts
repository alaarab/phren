import { ghEnv } from "../bridge/git-hosts.js";
import { execProbe } from "../bridge/probe-processes.js";
import type { Json } from "../bridge/protocol.js";
import { forgeFailure, ForgeError } from "./errors.js";
import { issueProvider, issueUrl, record, records } from "./provider.js";

export const githubIssues = issueProvider("github", async ({ domain, path, repo }) => {
  const base = `repos/${path}`;
  const item = (number: number) => `${base}/issues/${number}`;
  const env = ghEnv({ domain });

  async function gh(endpoint: string, method = "GET", body?: Json): Promise<unknown> {
    const args = ["api", endpoint, "--hostname", domain, "--method", method];
    if (body !== undefined) args.push("--input", "-");
    let stdout: string;
    try {
      ({ stdout } = await execProbe("gh", args, { env, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, input: body === undefined ? undefined : JSON.stringify(body) }));
    } catch (error) {
      const failure = error as { stderr?: string; code?: string };
      if (failure.code === "ENOENT") throw new ForgeError("unavailable", "GitHub CLI (gh) is required.");
      const message = failure.stderr ?? "";
      const status = Number(/\(HTTP (\d{3})\)\s*$/m.exec(message)?.[1] ?? 0);
      if (!status && /gh auth login|set the GH_TOKEN|not logged in/i.test(message)) throw forgeFailure(401);
      throw forgeFailure(status, status === 403 && /rate limit/i.test(message));
    }
    try { return JSON.parse(stdout); }
    catch { throw forgeFailure(0); }
  }

  async function ensureLabels(labels: string[]) {
    for (const name of labels) {
      const endpoint = `${base}/labels/${encodeURIComponent(name)}`;
      try { await gh(endpoint); }
      catch (error) {
        if (!(error instanceof ForgeError) || error.code !== "not-found") throw error;
        try { await gh(`${base}/labels`, "POST", { name, color: "7ba95b" }); }
        catch (error) {
          if (!(error instanceof ForgeError) || error.code !== "invalid") throw error;
          // Verify a competing create by reading the label again.
          await gh(endpoint).catch(() => { throw error; });
        }
      }
    }
  }

  return {
    async *pages(state) {
      for (let page = 1; ; page++) {
        const rows = records(await gh(`${base}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`));
        yield rows;
        if (rows.length < 100) return;
      }
    },
    async get(number) {
      return record(await gh(item(number)));
    },
    async create(title, body, labels) {
      await ensureLabels(labels);
      return record(await gh(`${base}/issues`, "POST", { title, body, labels }));
    },
    async edit(number, patch) {
      if (patch.labels) await ensureLabels(patch.labels);
      return record(await gh(item(number), "PATCH", { ...patch }));
    },
    async changeLabels(number, add, remove) {
      const endpoint = `${item(number)}/labels`;
      if (add.length) {
        await ensureLabels(add);
        await gh(endpoint, "POST", { labels: add });
      }
      for (const name of remove) {
        try { await gh(`${endpoint}/${encodeURIComponent(name)}`, "DELETE"); }
        catch (error) {
          // A competing write can remove the label before this request arrives.
          if (!(error instanceof ForgeError) || error.code !== "not-found") throw error;
        }
      }
    },
    async unassign(number, user) {
      await gh(`${item(number)}/assignees`, "DELETE", { assignees: [user] });
    },
    async comment(number, body) {
      const { id } = record(await gh(`${item(number)}/comments`, "POST", { body }));
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw forgeFailure(0);
      return { url: `${issueUrl(repo, number)}#issuecomment-${id}` };
    },
    async currentUser() {
      const { login } = record(await gh("user"));
      if (typeof login !== "string" || !login) throw forgeFailure(0);
      return login;
    },
  };
});
