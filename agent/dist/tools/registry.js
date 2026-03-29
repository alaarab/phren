import { checkPermission } from "../permissions/checker.js";
import { askUser } from "../permissions/prompt.js";
export class ToolRegistry {
    tools = new Map();
    permissionConfig;
    register(tool) {
        this.tools.set(tool.name, tool);
    }
    setPermissions(config) {
        this.permissionConfig = config;
    }
    getDefinitions() {
        return [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
        }));
    }
    async execute(name, input) {
        const tool = this.tools.get(name);
        if (!tool)
            return { output: `Unknown tool: ${name}`, is_error: true };
        // Permission check
        if (this.permissionConfig) {
            const rule = checkPermission(this.permissionConfig, name, input);
            if (rule.verdict === "deny") {
                return { output: `Permission denied: ${rule.reason}`, is_error: true };
            }
            if (rule.verdict === "ask") {
                const allowed = await askUser(name, input, rule.reason);
                if (!allowed) {
                    return { output: "User denied permission.", is_error: true };
                }
            }
        }
        try {
            return await tool.execute(input);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `Tool error: ${msg}`, is_error: true };
        }
    }
}
