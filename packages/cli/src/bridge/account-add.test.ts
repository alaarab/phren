import { expect, it } from "vitest";
import { addClaudeAccount } from "./account-add.js";
import { BridgeError } from "./protocol.js";

it("refuses a bad slug with a suggested one the phone can offer", async () => {
  const refusal = (input: unknown) => addClaudeAccount(input, "default").then(() => undefined, (error: unknown) => error);
  const named = await refusal({ slug: "Buildbox" });
  expect(named).toBeInstanceOf(BridgeError);
  expect(named).toMatchObject({ status: 400, details: { suggestedSlug: "buildbox" } });
  expect((named as BridgeError).message).toContain('Try "buildbox".');
  expect(await refusal({ slug: "Buildbox", email: "sam@example.com" })).toMatchObject({ status: 400, details: { suggestedSlug: "sam-example" } });
  expect(await refusal({ slug: "../../bad" })).toMatchObject({ status: 400, details: { suggestedSlug: "bad" } });
  expect(await refusal({ slug: "default" })).toMatchObject({ status: 400, details: { suggestedSlug: "default-2" } });
});
