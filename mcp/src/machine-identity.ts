import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { homePath } from "./shared.js";

const CORTEX_MACHINE_FILE = homePath(".cortex", ".machine-id");

function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export function machineFilePath(): string {
  return CORTEX_MACHINE_FILE;
}

export function defaultMachineName(): string {
  if (process.env.WSL_DISTRO_NAME && process.env.COMPUTERNAME) {
    return process.env.COMPUTERNAME.toLowerCase();
  }
  return os.hostname();
}

export function getMachineName(): string {
  const filePath = machineFilePath();
  if (fs.existsSync(filePath)) {
    const persisted = fs.readFileSync(filePath, "utf8").trim();
    if (persisted) return persisted;
  }
  return defaultMachineName();
}

export function persistMachineName(machine: string): void {
  const normalized = machine.trim();
  if (!normalized) return;
  atomicWriteText(machineFilePath(), `${normalized}\n`);
}
