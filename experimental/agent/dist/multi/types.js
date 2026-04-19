/**
 * IPC message types for parent <-> child agent communication.
 *
 * All messages flow over Node's built-in IPC channel (process.send / process.on("message")).
 * Each message has a `type` discriminant for exhaustive switching.
 */
export {};
