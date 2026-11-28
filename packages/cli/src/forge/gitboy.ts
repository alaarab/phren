import { resolveHostToken } from "../bridge/git-host-auth.js";
import { apiRoot, HostApiError, type HostRequest, hostJson } from "../bridge/git-host-http.js";
import type { Json } from "../bridge/protocol.js";
import { forgeFailure, ForgeError } from "./errors.js";
import { issueProvider, issueUrl, record, records } from "./provider.js";

const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 5;

export const gitboyIssues = issueProvider("gitboy", async ({ domain, path, repo }) => {
  const credentials = await resolveHostToken("gitboy", domain);
  if (!credentials) throw new ForgeError("auth", "Connect this gitboy host with phren bridge git-host set.");
  const { token } = credentials;
  const api = await apiRoot(process.cwd(), domain, `https://${domain}/api/v1`);
  const base = `/repos/${path}`;
  const item = (number: number) => `${base}/issues/${number}`;
  async function call(endpoint: string, method: HostRequest["method"] = "GET", body?: Json): Promise<unknown> {
    try {
      return (await hostJson(api + endpoint, { token, scheme: "bearer", method, body })).json;
    } catch (error) {
      throw forgeFailure(error instanceof HostApiError ? error.status : 0);
    }
  }

  async function labelIds(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const load = async () => new Map(records(await call(`${base}/labels`)).map(row => [String(row.name).toLowerCase(), row.id]));
    let known = await load();
    const ids: string[] = [];
    for (const name of names) {
      const key = name.toLowerCase();
      let id = known.get(key);
      if (id === undefined) {
        try { id = record(await call(`${base}/labels`, "POST", { name })).id; }
        catch (error) {
          // A concurrent request may have just created this name.
          if (!(error instanceof ForgeError) || !["invalid", "unavailable", "conflict"].includes(error.code)) throw error;
          known = await load();
          id = known.get(key);
          if (id === undefined) throw error;
        }
      }
      if (typeof id !== "string") throw forgeFailure(0);
      ids.push(id);
    }
    return ids;
  }

  return {
    async *pages(state) {
      const params = new URLSearchParams({ state, paginated: "true", limit: String(LIST_PAGE_SIZE) });
      for (let pageNumber = 1; pageNumber <= MAX_LIST_PAGES; pageNumber++) {
        const page = await call(`${base}/issues?${params}`);
        if (Array.isArray(page)) {
          yield records(page);
          return;
        }
        const response = record(page);
        const rows = records(response.items);
        yield rows;
        if (pageNumber === MAX_LIST_PAGES) return;
        const next = response.next_cursor;
        if (next === null || next === undefined) return;
        if (typeof next !== "string" || !/^[1-9]\d*$/.test(next) || Number(next) >= Number(params.get("cursor") ?? Infinity)) throw forgeFailure(0);
        params.set("cursor", next);
      }
    },
    async get(number) {
      return record(await call(item(number)));
    },
    async create(title, body, labels) {
      const label_ids = await labelIds(labels);
      return record(await call(`${base}/issues`, "POST", { title, body, label_ids }));
    },
    async edit(number, { labels, assignees, ...patch }) {
      const endpoint = item(number);
      const label_ids = labels && await labelIds(labels);
      let result: unknown;
      if (Object.keys(patch).length) result = await call(endpoint, "PATCH", patch);
      if (assignees) result = await call(`${endpoint}/assignees`, "PUT", { usernames: assignees });
      if (label_ids) result = await call(`${endpoint}/labels`, "PUT", { label_ids });
      return record(result);
    },
    async lockClaim(name) {
      let id: unknown;
      try { id = record(await call(`${base}/labels`, "POST", { name })).id; }
      catch (error) {
        if (error instanceof ForgeError && error.code === "conflict") return undefined;
        throw error;
      }
      if (typeof id !== "string") throw forgeFailure(0);
      const endpoint = `${base}/labels/${encodeURIComponent(id)}`;
      return async () => { await call(endpoint, "DELETE"); };
    },
    async comment(number, body) {
      const { id } = record(await call(`${item(number)}/comments`, "POST", { body }));
      if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw forgeFailure(0);
      return { url: `${issueUrl(repo, number)}#comment-${id}` };
    },
    async currentUser() {
      const { username } = record(await call("/user"));
      if (typeof username !== "string" || !username) throw forgeFailure(0);
      return username;
    },
  };
});
