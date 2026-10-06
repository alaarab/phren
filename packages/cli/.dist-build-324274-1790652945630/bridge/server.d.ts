import { ModelCatalog } from "./models.js";
import { AccountUsageReader } from "./usage.js";
export { capabilities, capabilitiesForModules, requireRoute } from "./server-routes.js";
export { streamCloseReason } from "./server-stream.js";
export { herdrAgentName, launchSession } from "./server-launch.js";
export declare function serve(version: string, options?: {
    modelCatalog?: ModelCatalog;
    accountUsage?: AccountUsageReader;
}): Promise<void>;
