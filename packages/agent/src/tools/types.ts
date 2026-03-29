/** Agent tool types. */

export interface AgentToolResult {
  output: string;
  is_error?: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<AgentToolResult>;
}
