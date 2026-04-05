import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { errorMessage } from "../utils.js";
import { logger } from "../logger.js";

export function resolveProjectStorePath(phrenPath: string, project: string): string {
  try {
    const { getNonPrimaryStores } = require("../store-registry.js");
    if (fs.existsSync(path.join(phrenPath, project))) return phrenPath;
    for (const store of getNonPrimaryStores(phrenPath)) {
      if (fs.existsSync(path.join(store.path, project))) return store.path;
    }
  } catch { /* fall through */ }
  return phrenPath;
}

export function getOptionValue(args: string[], name: string): string | undefined {
  const exactIdx = args.indexOf(name);
  if (exactIdx !== -1) return args[exactIdx + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

export function parseMcpToggle(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "enabled") return true;
  if (normalized === "off" || normalized === "false" || normalized === "disabled") return false;
  return undefined;
}

export function openInEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  try {
    execFileSync(editor, [filePath], { stdio: "inherit" });
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG)) logger.debug("cli-namespaces", `openInEditor: ${errorMessage(err)}`);
    console.error(`Editor "${editor}" failed. Set $EDITOR to your preferred editor.`);
    process.exit(1);
  }
}
