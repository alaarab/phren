import type { ModuleSnapshot } from "./modules/runtime.js";
import { type Topic } from "./cli-registry.js";
export declare function formatCheatSheet(snapshot?: ModuleSnapshot): string;
export declare function formatTopic(topic: Topic, snapshot?: ModuleSnapshot): string;
export declare function formatDocTopic(name: string): string | null;
export declare function formatCommand(name: string, snapshot?: ModuleSnapshot): string | null;
export declare function formatFullHelp(snapshot?: ModuleSnapshot): string;
