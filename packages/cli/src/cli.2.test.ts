// Shard 2 of 2 of cli.suite.ts, which spawns the CLI for most cases.
import { useShard } from "./test-shard.js";
useShard(1, 2);
await import("./cli.suite.js");
