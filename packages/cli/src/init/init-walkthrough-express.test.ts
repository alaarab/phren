import { afterEach, expect, it, vi } from "vitest";

const asked: string[] = [];
let answers: boolean[] = [];
vi.mock("inquirer", () => ({
  input: async () => "",
  select: async () => "",
  confirm: async ({ message }: { message: string }) => { asked.push(message); return answers.shift() ?? false; },
}));

const { runWalkthrough } = await import("./init-walkthrough.js");
afterEach(() => { asked.length = 0; });

it("after one yes, offers GitHub sync to a signed-in gh user and phone pairing", async () => {
  answers = [true, true, true];
  const result = await runWalkthrough("/tmp/phren-express-test", { githubLogin: async () => "octo" });
  expect(asked[0]).toMatch(/recommended settings/);
  expect(asked[1]).toBe("Sync memory to a private GitHub repo (octo/my-phren)?");
  expect(result).toMatchObject({ githubUsername: "octo", githubRepo: "my-phren", githubCreate: true });
  if (["darwin", "linux"].includes(process.platform)) expect(result.connectPhone).toBe(true);
});

it("skips the GitHub offer without gh, and --advanced skips the recommended-settings question", async () => {
  answers = [true, false];
  const quick = await runWalkthrough("/tmp/phren-express-test", { githubLogin: async () => undefined });
  expect(asked.some(message => message.includes("GitHub"))).toBe(false);
  expect(quick.githubCreate).toBeUndefined();
  asked.length = 0; answers = [];
  await runWalkthrough("/tmp/phren-express-test", { advanced: true, githubLogin: async () => undefined });
  expect(asked.some(message => message.includes("recommended settings"))).toBe(false);
});
