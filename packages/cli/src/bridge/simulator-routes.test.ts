import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_MODULES } from "../modules/registry.js";
import type { Json } from "./protocol.js";

const mocks = vi.hoisted(() => ({
  booted: vi.fn(async () => [{ udid: "AAAAAAAA-1111-4111-8111-111111111111", name: "iPhone 17 Pro", runtime: "iOS 26.1" }]),
  devices: vi.fn(async () => [{ udid: "AAAAAAAA-1111-4111-8111-111111111111", name: "iPhone 17 Pro", runtime: "iOS 26.1", state: "Booted" },
    { udid: "BBBBBBBB-2222-4222-8222-222222222222", name: "iPhone 15", runtime: "iOS 18.2", state: "Shutdown" }]),
  act: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./simulators.js", async original => ({ ...await original<typeof import("./simulators.js")>(),
  bootedSimulators: mocks.booted, simulatorDevices: mocks.devices, simulatorAct: mocks.act }));
const { capabilitiesForModules, createRouteHandler } = await import("./server-routes.js");

const modules = { has: () => true, modules: BUILTIN_MODULES };
async function request(method: string, url: string, body?: Json): Promise<{ status: number; body: Json }> {
  const handler = createRouteHandler({ modules, info: { computer: { id: "00000000-0000-4000-8000-0000000000aa", name: "self" }, capabilities: capabilitiesForModules(modules as never) },
    accountUsage: { read: async () => ({ accounts: [] }) }, streams: {} } as never);
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as IncomingMessage;
  req.method = method; req.url = url; req.headers = {};
  let payload = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: JSON.parse(payload) as Json };
}

describe("simulator routes", () => {
  it("offers the device list and drag where simulators run, as /v1/health reports capabilities", () => {
    const capabilities = capabilitiesForModules(modules as never);
    expect(capabilities.simulatorDevices).toBe(process.platform === "darwin");
    expect(capabilities.simulatorDrag).toBe(process.platform === "darwin");
    // Without the hook module neither is offered.
    expect(capabilitiesForModules({ has: () => false, modules: [] } as never)).not.toHaveProperty("simulatorDevices");
  });

  it("lists every device with its state for all=1, and only the booted ones otherwise, as before", async () => {
    expect((await request("GET", "/v1/simulators")).body).toEqual({ simulators: [{ udid: "AAAAAAAA-1111-4111-8111-111111111111", name: "iPhone 17 Pro", runtime: "iOS 26.1" }] });
    const all = await request("GET", "/v1/simulators?all=1");
    expect(all.body).toMatchObject({ simulators: [{ state: "Booted" }, { name: "iPhone 15", state: "Shutdown" }] });
    expect(mocks.devices).toHaveBeenCalledTimes(1);
  });

  it("passes a drag's points and duration to the simulator", async () => {
    const udid = "AAAAAAAA-1111-4111-8111-111111111111";
    expect(await request("POST", "/v1/simulators/action", { udid, action: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 400 }))
      .toMatchObject({ status: 200, body: { ok: true } });
    expect(mocks.act).toHaveBeenCalledWith(udid, { action: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 400 });
  });
});
