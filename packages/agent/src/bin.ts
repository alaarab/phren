#!/usr/bin/env node
export {};
const argv = process.argv.slice(2);
// `phren-agent models [--json]` lists the model catalog without loading the agent.
if (argv[0] === "models") (await import("./models-list.js")).refreshModelsCommand(argv.slice(1));
else (await import("./index.js")).runAgentCli(argv);
