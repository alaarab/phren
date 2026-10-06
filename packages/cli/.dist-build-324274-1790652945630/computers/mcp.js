import { VERSION } from "../package-metadata.js";
import { combineUsage, describe, findComputer, pickComputer, readComputers, readUsage } from "./read.js";
/**
 * `phren computers mcp`: a stdio MCP server with four read-only tools over
 * the Phren Hook: list computers, one computer's resources, the least-loaded
 * computer, and agent usage. It never opens a Phren store and has no memory,
 * finding or task tools, so it can be handed to an agent that must not see
 * them. Register it with `claude mcp add phren-computers -- phren computers mcp`.
 */
const INSTRUCTIONS = [
    "Read-only view of the owner's computers and agent usage, answered by the Phren Hook.",
    "Before a heavy job (Xcode or simulator tests, emulators, Gradle), call pick_computer and run it there; check get_resources before starting a second heavy job on a computer.",
    "A computer whose level is 'stressed' (load above twice its cores, under 10 GB free disk, or critical memory) should not get new heavy work.",
    "get_usage shows each harness's limits, windows and time until reset; a harness that reports nothing says so.",
].join(" ");
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export async function serveComputersMcp() {
    const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/mcp.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
        import("zod"),
    ]);
    const server = new McpServer({ name: "phren-computers", version: VERSION }, { instructions: INSTRUCTIONS });
    server.registerTool("list_computers", {
        title: "List computers",
        description: "Every computer this Hook knows (this one and each linked one): online, platform, load level, CPU load against cores, free memory and disk, warnings. Read-only.",
        inputSchema: z.object({}),
        annotations: readOnly,
    }, async () => {
        const report = await readComputers();
        return text({
            computers: report.computers.map(c => c.resources ? {
                name: c.name, local: c.local, online: true, platform: c.resources.platform, level: c.resources.level, warnings: c.resources.warnings,
                pressure: c.resources.pressure.overall, cores: c.resources.cpu.cores, load1: c.resources.cpu.load1,
                memoryFreePercent: c.resources.memory.availablePercent, diskFreeGB: c.resources.disk ? Math.round(c.resources.disk.freeBytes / 1024 ** 3 * 10) / 10 : undefined,
                heavyJobs: c.resources.heavy.length, summary: describe(c.resources),
            } : { name: c.name, local: c.local, online: false, error: c.error }),
            ...(report.hookError ? { hookError: report.hookError } : {}), ...(report.peerError ? { peerError: report.peerError } : {}),
        });
    });
    server.registerTool("get_resources", {
        title: "Get a computer's resources",
        description: "One computer's live resources: load averages and cores, memory, free disk on the home volume, battery, uptime, and heavy jobs (simulators, emulators, xcodebuild, Gradle, agent workers) with the terminal pane that started each where known. Omit computer for this one. Read-only.",
        inputSchema: z.object({ computer: z.string().max(253).optional().describe("Computer name (or prefix) from list_computers; omit for this computer.") }),
        annotations: readOnly,
    }, async ({ computer }) => {
        const report = await readComputers({ peers: Boolean(computer) });
        const found = findComputer(report.computers, computer);
        if (!found)
            return failure(`No computer named ${computer}. Known: ${report.computers.map(c => c.name).join(", ")}`);
        return text(found.resources ? { name: found.name, local: found.local, ...found.resources } : { name: found.name, online: false, error: found.error });
    });
    server.registerTool("pick_computer", {
        title: "Pick the least-loaded computer",
        description: "The least-loaded online computer for a heavy job, with the ranking and why. Defaults to Macs (Xcode, simulators). Read-only; it starts nothing.",
        inputSchema: z.object({
            platform: z.enum(["mac", "linux", "any"]).optional().describe("mac (default), linux or any."),
            exclude: z.array(z.string().max(253)).max(32).optional().describe("Computer names to leave out."),
        }),
        annotations: readOnly,
    }, async ({ platform, exclude }) => {
        const result = pickComputer((await readComputers()).computers, platform ?? "mac", exclude ?? []);
        return text({ pick: result.pick?.name ?? null, reason: result.reason, ranked: result.ranked });
    });
    server.registerTool("get_usage", {
        title: "Get agent usage",
        description: "Agent usage per harness (Claude, Codex, GitHub Copilot, OpenCode incl. DeepSeek via its local spend, OpenCode Go, OpenRouter): limits and windows with percent used and time until reset, and recent spend where the harness reports it. Per computer and combined. A harness that reports nothing says so. No credentials are ever included. Read-only.",
        inputSchema: z.object({
            computer: z.string().max(253).optional().describe("Only this computer (name or prefix)."),
            view: z.enum(["combined", "per-computer", "both"]).optional().describe("combined (default), per-computer or both."),
        }),
        annotations: readOnly,
    }, async ({ computer, view }) => {
        const report = await readUsage();
        if (report.hookError)
            return failure(report.hookError);
        const computers = computer ? report.computers.filter(c => c.name.toLowerCase().startsWith(computer.toLowerCase())) : report.computers;
        if (computer && !computers.length)
            return failure(`No computer named ${computer}. Known: ${report.computers.map(c => c.name).join(", ")}`);
        const combined = computer ? combineUsage(computers.flatMap(c => c.harnesses ? [c.harnesses] : [])) : report.combined;
        const mode = view ?? "combined";
        return text({
            ...(mode !== "per-computer" ? { combined } : {}),
            ...(mode !== "combined" ? { computers } : { computersReporting: computers.map(c => c.error ? `${c.name} (not reporting: ${c.error})` : c.name) }),
        });
    });
    const transport = new StdioServerTransport();
    // The CLI exits once a command returns, so serve until the client hangs up.
    let hangUp = () => { };
    const closed = new Promise(resolve => { hangUp = resolve; process.stdin.once("end", resolve); });
    await server.connect(transport);
    server.server.onclose = hangUp;
    console.error("phren-computers MCP server running (read-only, no memory)");
    await closed;
}
