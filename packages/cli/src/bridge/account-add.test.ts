import { expect, it } from "vitest";
import { addClaudeAccount } from "./account-add.js";
import { BridgeError } from "./protocol.js";

it("refuses a bad slug with a suggested one the phone can offer", async () => {
  const refusal = (input: unknown) => addClaudeAccount(input, "default").then(() => undefined, (error: unknown) => error);
  const named = await refusal({ slug: "Linuxbox" });
  expect(named).toBeInstanceOf(BridgeError);
  expect(named).toMatchObject({ status: 400, details: { suggestedSlug: "linuxbox" } });
  expect((named as BridgeError).message).toContain('Try "linuxbox".');
  expect(await refusal({ slug: "Linuxbox", email: "ala@alaarab.com" })).toMatchObject({ status: 400, details: { suggestedSlug: "ala-alaarab" } });
  expect(await refusal({ slug: "../../bad" })).toMatchObject({ status: 400, details: { suggestedSlug: "bad" } });
  expect(await refusal({ slug: "default" })).toMatchObject({ status: 400, details: { suggestedSlug: "default-2" } });
});
