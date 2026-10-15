import { afterEach, describe, expect, it, vi } from "vitest";
import { connectProjectHost, hostTokenError, projectHostTokenRequest, tokenDestinationText } from "../ui/project-host-token.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("project host Connect", () => {
  it("posts the password with the displayed host to the encoded project route on its computer", async () => {
    const host = { domain: "gitlab.example.com" };
    expect(projectHostTokenRequest("app docs", host, "  secret  ")).toEqual({
      route: "/v1/projects/app%20docs/git/host-token",
      body: { token: "secret", expectedHost: "gitlab.example.com" },
    });
    const fetchHook = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchHook);
    await expect(connectProjectHost("dev box", "app docs", host, "secret")).resolves.toEqual({ ok: true });
    const [url, request] = fetchHook.mock.calls[0];
    expect(url).toBe("/hosts/dev%20box/v1/projects/app%20docs/git/host-token");
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toEqual({ token: "secret", expectedHost: "gitlab.example.com" });
  });

  it("shows and sends the configured API destination instead of the remote domain", () => {
    const host = { domain: "gitlab.example.com", apiHost: "other.example:8443" };
    expect(tokenDestinationText(host)).toBe("Sends the token to other.example:8443");
    expect(projectHostTokenRequest("app", host, "secret").body)
      .toEqual({ token: "secret", expectedHost: "other.example:8443" });
  });

  it.each([
    [{ code: "host-changed" }, "The project's remote changed. Reopen to review the new host."],
    [{ code: "no-checkout" }, "No checkout of this project on this computer."],
    [{ reason: "auth" }, "The host refused that token."],
    [{ message: "echoed-secret" }, "Could not connect to the host. Check the token and try again."],
  ])("maps a refusal without displaying arbitrary response text (%j)", (error, expected) => {
    expect(hostTokenError(error)).toBe(expected);
  });

  it("preserves a 409 host-changed code through the Hook transport", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "host-changed", error: "Remote changed" }), { status: 409 })));
    const failure = await connectProjectHost("dev", "app", { domain: "gitlab.example.com" }, "secret").catch(error => error);
    expect(failure.code).toBe("host-changed");
    expect(hostTokenError(failure)).toBe("The project's remote changed. Reopen to review the new host.");
  });

  it("treats a 200 host authentication refusal as a failed connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, reason: "auth", message: "secret" }))));
    await expect(connectProjectHost("dev", "app", { domain: "gitlab.example.com" }, "secret"))
      .rejects.toMatchObject({ message: "The host refused that token.", reason: "auth" });
  });
});
