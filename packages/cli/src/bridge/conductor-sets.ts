import { z } from "zod";
import { type Computer, computerLabel, readComputers } from "./computer-identity.js";
import { localNames } from "./computer-names.js";
import { askPeers, buildSets, indirectMembers, localCaller } from "./conductor-group.js";
import { readSetName, saveSetName } from "./conductor-role.js";
import { listsCaller } from "./health.js";
import { type LinkResult, linkComputer } from "./link.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { BridgeError, type Json, object } from "./protocol.js";
import { localConductor } from "./server-launch.js";

/** The Hook routes for linked computer sets (docs/conductor-sets.md). */

interface LocalInfo { computer: { id: string; name: string; aliases?: string[] } }

const callerSchema = z.object({ name: z.string().max(253).optional(), hostKey: z.string().max(512).optional() });

/** `GET /v1/conductor`: this computer's live conductor and what a peer needs
 * to place it in a set. Asked with the caller's name or host key, it also
 * says whether this computer lists the caller back. */
export async function conductorAnswer(info: LocalInfo, url: URL): Promise<Json> {
  const caller = callerSchema.parse({ name: url.searchParams.get("name") ?? undefined, hostKey: url.searchParams.get("hostKey") ?? undefined });
  const [conductor, links, set] = await Promise.all([localConductor(), listsCaller(caller), readSetName()]);
  return { computer: info.computer, conductor: conductor ?? null, peers: links.computers,
    ...(caller.name || caller.hostKey ? { knowsCaller: links.knowsCaller } : {}), ...(set ? { set } : {}) };
}

/** `GET /v1/sets`: this computer's set and every set its one-way peers are in, plus unlinked computers. */
export async function readSets(info: LocalInfo): Promise<Json> {
  const [{ peers, peerError }, conductor, set, { computers }] = await Promise.all([optionalHookPeers(), localConductor(), readSetName(),
    readComputers({ local: { id: info.computer.id } })]);
  const answers = await askPeers(peers, await localCaller());
  // Old /v1/conductor replies list peer names without ids. Resolve unknown
  // names through the existing identity directory, also on older Hooks.
  // Skip this extra round when names already identify every member.
  const indirect = new Set(indirectMembers(answers, [info.computer.name, ...(info.computer.aliases ?? []), ...localNames()]).map(computerLabel));
  const reportedComputers = (await Promise.all(answers.map(async answer => {
    if (!answer.ok || answer.knowsCaller === false || !answer.peers?.some(name => indirect.has(computerLabel(name)))) return [];
    try {
      const directory = await peerRequest(answer.peer, "/v1/computers", undefined, 12_000);
      return (Array.isArray(directory.computers) ? directory.computers.slice(0, 64) : []).flatMap(value => {
        const row = object(value);
        return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name,
          aliases: (Array.isArray(row.aliases) ? row.aliases : []).filter((name): name is string => typeof name === "string").slice(0, 64) }] : [];
      });
    } catch { return []; } // Missing or offline identity directory keeps the name-only view.
  }))).flat() satisfies Pick<Computer, "id" | "name" | "aliases">[];
  const view = buildSets({ local: { name: info.computer.name, id: info.computer.id, ...(conductor ? { conductor } : {}), ...(set ? { set } : {}),
    names: [info.computer.name, ...(info.computer.aliases ?? []), ...localNames()] }, answers, computers, reportedComputers });
  return { ...view, ...(peerError ? { peerError } : {}) } as unknown as Json;
}

const setNameValue = z.string().trim().min(1).max(60).refine(t => !/[\x00-\x1f\x7f]/.test(t)).nullable();

/** `POST /v1/sets/name`: names this computer's set. The owner's call is sent
 * on to every reachable member; a member's relay (with `namedAt`) is kept
 * when newer than the name held, and goes no further. */
export async function nameSet(data: Json): Promise<Json> {
  const input = z.object({ name: setNameValue, namedAt: z.string().datetime().optional() }).strict().parse(data);
  if (input.namedAt) return { ok: true, name: input.name, changed: await saveSetName(input.name, input.namedAt) };
  const namedAt = new Date().toISOString();
  await saveSetName(input.name, namedAt);
  const { peers } = await optionalHookPeers();
  const answers = await askPeers(peers, await localCaller());
  const told: string[] = [], unreachable: { computer: string; error: string }[] = [];
  await Promise.all(answers.map(async answer => {
    // A one-way peer is in another set; a peer that could not answer is named so the owner knows it missed the name.
    if (answer.ok && answer.knowsCaller === false) return;
    if (!answer.ok) { if (!answer.disabled) unreachable.push({ computer: answer.peer.name, error: answer.error }); return; }
    try { await peerRequest(answer.peer, "/v1/sets/name", { name: input.name, namedAt }, 8_000); told.push(answer.peer.name); }
    catch (error) { unreachable.push({ computer: answer.peer.name, error: error instanceof Error ? error.message.slice(0, 300) : "Unreachable." }); }
  }));
  return { ok: true, name: input.name, namedAt, told: told.sort(), unreachable: unreachable.sort((a, b) => a.computer.localeCompare(b.computer)) };
}

const linkInput = z.object({ name: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/, "A computer name or ssh host.") }).strict();
let linking: string | undefined;

/** `POST /v1/sets/link`: the phone's one-tap `phren bridge link <name>`. Runs
 * on the computer whose set lists `name` as indirect or one-way, over this
 * computer's own ssh login, one link at a time. */
export async function linkSetMember(data: Json, link: typeof linkComputer = linkComputer): Promise<LinkResult> {
  if (data && typeof data === "object" && "origin" in data) throw new BridgeError(403, "Only the owner links computers, from the phone or `phren bridge link` in their own terminal.");
  const { name } = linkInput.parse(data);
  if (linking) throw new BridgeError(409, `Already linking ${linking}. Try again when it finishes.`);
  linking = name;
  try { return await link(name); } finally { linking = undefined; }
}
