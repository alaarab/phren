/** Agent tool types. */

/** An image a tool hands back to the model (rides inside the tool_result). */
export interface AgentToolImage {
  media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

export interface AgentToolResult {
  output: string;
  is_error?: boolean;
  /** Images to attach to the tool result (only meaningful on vision models). */
  images?: AgentToolImage[];
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * Per-call budget in ms; the scheduler default (120s) applies when absent.
   * Declaring one asserts the tool forwards `signal` cooperatively — the
   * deadline aborts the signal AND settles the call, but a tool that ignores
   * the signal keeps running detached (same honesty as any cooperative
   * cancellation).
   */
  timeoutMs?: number;
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult>;
}
