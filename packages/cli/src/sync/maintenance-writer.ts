/**
 * One computer rewrites a store's generated files (topic `## Now` blocks,
 * summary.md's "What phren knows", archived tasks, pruned findings) at a
 * time. When every computer's background maintenance rewrote them, each
 * sync merged two rewrites of the same lines. The holder renews its lease
 * daily as it runs; a holder that has stopped running loses it after three
 * days to the next computer that does.
 */
import * as fs from "fs";
import * as path from "path";
import { getMachineName } from "../machine-identity.js";
import { atomicWriteText } from "../phren-paths.js";

export const MAINTENANCE_WRITER_FILE = ".config/maintenance-writer.json";
export const MAINTENANCE_LEASE_MS = 3 * 86_400_000;
const RENEW_AFTER_MS = 86_400_000;

interface Lease { computer: string; renewedAt: string }

function readLease(file: string): Lease | undefined {
  try {
    const lease = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof lease?.computer === "string" && lease.computer && typeof lease.renewedAt === "string" && !Number.isNaN(Date.parse(lease.renewedAt))
      ? lease : undefined;
  } catch { return undefined; }
}

/** Whether this computer may rewrite generated files now; claims or renews the lease when it may. */
export function claimMaintenanceWriter(phrenPath: string, computer = getMachineName(), now = Date.now()): { writer: boolean; holder: string } {
  const file = path.join(phrenPath, MAINTENANCE_WRITER_FILE);
  const lease = readLease(file);
  const age = lease ? now - Date.parse(lease.renewedAt) : Number.POSITIVE_INFINITY;
  if (lease && lease.computer !== computer && age < MAINTENANCE_LEASE_MS) return { writer: false, holder: lease.computer };
  if (!lease || lease.computer !== computer || age > RENEW_AFTER_MS) {
    atomicWriteText(file, `${JSON.stringify({ computer, renewedAt: new Date(now).toISOString() }, null, 2)}\n`);
  }
  return { writer: true, holder: computer };
}
