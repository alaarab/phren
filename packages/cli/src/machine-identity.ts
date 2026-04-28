import * as fs from "fs";
import * as os from "os";
import { homePath, atomicWriteText } from "./shared.js";

function phrenMachineFilePath(): string {
  return homePath(".phren", ".machine-id");
}

export function machineFilePath(): string {
  return phrenMachineFilePath();
}

export function defaultMachineName(): string {
  if (process.env.WSL_DISTRO_NAME && process.env.COMPUTERNAME) {
    return process.env.COMPUTERNAME.toLowerCase();
  }
  return os.hostname();
}

let cachedMachineName: string | null = null;

export function getMachineName(): string {
  if (cachedMachineName !== null) return cachedMachineName;
  const filePath = machineFilePath();
  if (fs.existsSync(filePath)) {
    const persisted = fs.readFileSync(filePath, "utf8").trim();
    if (persisted) return (cachedMachineName = persisted);
  }
  return (cachedMachineName = defaultMachineName());
}

export function persistMachineName(machine: string): void {
  const normalized = machine.trim();
  if (!normalized) return;
  atomicWriteText(machineFilePath(), `${normalized}\n`);
  cachedMachineName = normalized;
}

export function getCurrentActor(): string {
  return process.env.PHREN_ACTOR || process.env.USER || "unknown";
}
