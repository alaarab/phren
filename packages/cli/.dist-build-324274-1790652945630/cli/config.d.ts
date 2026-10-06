import { checkProjectInProfile } from "./config-shared.js";
import { handleIndexPolicy, handleRetentionPolicy, handleWorkflowPolicy } from "./config-policy.js";
import { handleConfigAccess } from "./config-access.js";
export { checkProjectInProfile, handleIndexPolicy, handleRetentionPolicy, handleWorkflowPolicy, handleConfigAccess };
export { buildProactivitySnapshot } from "./config-proactivity.js";
export { FINDING_SENSITIVITY_CONFIG } from "./config-policy.js";
export declare function handleConfig(args: string[]): Promise<void>;
