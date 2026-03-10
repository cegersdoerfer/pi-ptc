import type { ToolDefinition, ToolInfo as ExtensionToolInfo } from "@mariozechner/pi-coding-agent";

import type { ChildProcess } from "child_process";

export interface SandboxManager {
  /**
   * Spawn a TypeScript process in the sandbox for RPC communication
   * @param codeOrFile Path to TypeScript file (subprocess) or file to transpile (Docker)
   * @param cwd Current working directory
   * @returns ChildProcess for bidirectional communication
   */
  spawn(codeOrFile: string, cwd: string): ChildProcess;

  /**
   * Cleanup sandbox resources
   */
  cleanup(): Promise<void>;
}

export interface ToolInfo extends ExtensionToolInfo {
  execute: ToolDefinition["execute"];
}

export type RpcMessage =
  | { type: "init"; tools: string[]; cwd: string }
  | { type: "tool_call"; id: string; tool: string; params: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: any[]; error?: string }
  | { type: "execution_progress"; line: number; total_lines: number }
  | { type: "complete"; output: string }
  | { type: "error"; message: string; traceback?: string }
  | { type: "update"; message: string };

import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";

export interface ExecutionOptions {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<any>;
}

export interface ExecutionDetails {
  currentLine?: number;
  totalLines?: number;
  userCode?: string[];
}
