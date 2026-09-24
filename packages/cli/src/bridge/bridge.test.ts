// Shard 1 of 3 of bridge.suite.ts, which starts real Hook processes.
import { useShard } from "../test-shard.js";
useShard(0, 3);
await import("./bridge.suite.js");
