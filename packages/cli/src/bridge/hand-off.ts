import { z } from "zod";
import { computerName } from "./computers.js";
import { hookRequest } from "./client.js";
import { projectName } from "./dispatch.js";
import { grantLabel, listGrants, matchGrant } from "./grants.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, objects, sessionId, targetSchema, type Json, type Target } from "./protocol.js";

const promptText = z.string().min(1).max(32768).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value));

export const handOffSchema = z.object({
  computer: computerName.optional().describe("Enrolled computer name. Omit for this computer."),
  target: targetSchema.optional().describe("Complete live target for the existing session."),
  session: sessionId.optional().describe("Session id to resolve through the Hook workspace overview."),
  project: projectName.optional().describe("Project slug this hand-off belongs to, for conductor grant matching."),
  text: promptText.describe("Prompt to deliver to the existing session, at most 32768 characters."),
}).strict().superRefine((value, context) => {
  if ((value.target === undefined) === (value.session === undefined)) context.addIssue({ code: "custom", message: "Provide exactly one of target or session." });
});
export type HandOffInput = z.infer<typeof handOffSchema>;

type Request = (route: string, data?: Json) => Promise<Json>;

async function targetFromOverview(request: Request, session: string, server?: string): Promise<Target> {
  const route = server ? `/v1/workspaces?server=${encodeURIComponent(server)}` : "/v1/workspaces";
  const overview = await request(route);
  for (const group of objects(overview.groups)) for (const tab of objects(group.children)) {
    const parsed = targetSchema.safeParse(tab.target);
    if (parsed.success && parsed.data.session === session) return parsed.data;
  }
  throw new BridgeError(404, "No live session with that id appears in the workspace overview.");
}

export async function handOff(input: unknown): Promise<{ ok: boolean; delivered: boolean; target: Target; granted?: string }> {
  const data = handOffSchema.parse(input);
  let request: Request;
  let peer: HookPeer | undefined;
  if (data.computer === undefined) request = (route, body) => hookRequest(route, body);
  else {
    peer = (await hookPeers()).find(candidate => candidate.name === data.computer);
    if (!peer) throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
    request = (route, body) => peerRequest(peer!, route, body);
  }
  const target = data.target ?? await targetFromOverview(request, data.session!, peer?.server);
  if (peer && target.server !== peer.server) throw new BridgeError(400, "The target belongs to a different Herdr server on that computer.");
  const grant = matchGrant(await listGrants(), { action: "hand_off", project: data.project, computer: data.computer });
  const result = await request("/v1/prompt", { target, text: data.text });
  const delivered = result.ok === true && result.deliveryUncertain !== true;
  return { ok: delivered, delivered, target, ...(grant ? { granted: grantLabel(grant) } : {}) };
}
