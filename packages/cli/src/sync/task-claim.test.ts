import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readTasks } from "../data/tasks.js";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { claimTaskSynced } from "./task-claim.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();

let tmp: { path: string; cleanup: () => void };
let mini: string, laptop: string;

// Two computers' clones of one store remote, as two unlinked conductors see it.
beforeEach(() => {
  tmp = makeTempDir("phren-claim-");
  const remote = path.join(tmp.path, "remote.git"), seed = path.join(tmp.path, "seed");
  git(tmp.path, "init", "--bare", "--initial-branch=main", remote);
  fs.mkdirSync(path.join(seed, "phren"), { recursive: true });
  git(seed, "init", "--initial-branch=main");
  initTestPhrenRoot(seed);
  fs.writeFileSync(path.join(seed, ".gitignore"), ".runtime/\n");
  fs.writeFileSync(path.join(seed, "phren", "tasks.md"),
    "# phren tasks\n\n## Active\n\n## Queue\n\n- [ ] Port the parser <!-- bid:aaaa1111 rank:1 -->\n- [ ] Fix the menu <!-- bid:bbbb2222 rank:2 -->\n\n## Done\n");
  // Each git process costs a second or more on a loaded Windows runner, where
  // the 13 this setup once spawned outlasted the hook timeout: identities go
  // on the command line and into the clone, not through separate config calls.
  git(seed, "add", "-A"); git(seed, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "seed");
  git(seed, "push", "-q", remote, "main");
  [mini, laptop] = ["mini", "laptop"].map(name => {
    const clone = path.join(tmp.path, name);
    git(tmp.path, "clone", "-q", "-c", "user.email=t@example.com", "-c", `user.name=${name}`, remote, clone);
    return clone;
  });
}, 30_000);
afterEach(() => tmp.cleanup());

const task = (store: string, bid: string) => {
  const doc = readTasks(store, "phren");
  if (!doc.ok) throw new Error(doc.error);
  return [...doc.data.items.Active, ...doc.data.items.Queue].find(item => item.stableId === bid);
};

it("gives a task to the first conductor that claims it and turns the other away until it is released", async () => {
  const claimed = await claimTaskSynced(mini, "phren", "bid:aaaa1111", { computer: "Mini", at: "2026-09-25T04:30:00Z", session: "w22-p1" });
  expect(claimed).toMatchObject({ claimed: true, synced: true });
  // The claim reached the remote as the Active task's Claimed line.
  expect(git(tmp.path, "--git-dir=remote.git", "show", "main:phren/tasks.md")).toContain(
    "## Active\n\n- [ ] Port the parser <!-- bid:aaaa1111 rank:1 -->\n  Claimed: Mini 2026-09-25T04:30:00Z session:w22-p1\n");

  const refused = await claimTaskSynced(laptop, "phren", "bid:aaaa1111", { computer: "Laptop", at: "2026-09-25T04:31:00Z" });
expect(refused).toMatchObject({ claimed: false, error: "Mini claimed this task at 2026-09-25T04:30:00Z." });
  expect(task(laptop, "aaaa1111")).toMatchObject({ section: "Active", claim: { computer: "Mini" } });
  // force takes over only a claim more than a day old, never a fresh one.
  expect((await claimTaskSynced(laptop, "phren", "bid:aaaa1111", { computer: "Laptop", at: "2026-09-25T04:31:00Z" }, { force: true })).claimed).toBe(false);

  expect(await claimTaskSynced(mini, "phren", "bid:aaaa1111", { computer: "Mini", at: "2026-09-25T05:00:00Z" }, { release: true }))
    .toMatchObject({ claimed: false, synced: true });
  expect(await claimTaskSynced(laptop, "phren", "bid:aaaa1111", { computer: "Laptop", at: "2026-09-25T05:01:00Z" }))
    .toMatchObject({ claimed: true, synced: true });
  expect(task(mini, "aaaa1111")?.claim).toBeUndefined();
  expect(task(laptop, "aaaa1111")).toMatchObject({ section: "Active", claim: { computer: "Laptop", at: "2026-09-25T05:01:00Z" } });
});
