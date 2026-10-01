import { PhrenError } from "../phren-core.js";
import { listMachines } from "../profile-store.js";
import { localNames } from "./computer-names.js";

/** Registered here, without a configured Hook connection; reachability is unknown. */
export interface NotLinkedComputer { name: string; aliases?: string[] }

export interface ComputerLinkInventory {
  registry: { status: "ok" | "unavailable" | "error" };
  /** Absent unless both the registry and peer configuration were successfully read. */
  notLinked?: NotLinkedComputer[];
}

/** DHCP/Bonjour suffixes do not distinguish computers; IPv4 addresses stay whole. */
export function computerLabel(name: string): string {
  const value = name.trim().toLowerCase();
  return /^\d+(\.\d+){3}$/.test(value) ? value : value.split(".")[0] ?? "";
}

/** Undefined linked names means the peer configuration could not be read. */
export function computerLinkInventory(store: string | null, here: string, linked: readonly string[] | undefined): ComputerLinkInventory {
  if (!store) return { registry: { status: "unavailable" } };
  const machines = listMachines(store);
  if (!machines.ok) return { registry: { status: machines.code === PhrenError.FILE_NOT_FOUND ? "unavailable" : "error" } };
  if (!linked) return { registry: { status: "ok" } };
  const known = new Set([here, ...localNames(), ...linked].map(computerLabel).filter(Boolean));
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(machines.data)) {
    const label = computerLabel(name);
    if (!label || known.has(label)) continue;
    groups.set(label, [...(groups.get(label) ?? []), name]);
  }
  const notLinked = [...groups.values()].map(names => {
    const [name, ...aliases] = [...names].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return aliases.length ? { name, aliases } : { name };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { registry: { status: "ok" }, notLinked };
}

/** Legacy MCP shape; health uses the inventory to retain unknown/error states. */
export function notLinkedComputers(store: string | null, here: string, linked: readonly string[]): NotLinkedComputer[] {
  return computerLinkInventory(store, here, linked).notLinked ?? [];
}
