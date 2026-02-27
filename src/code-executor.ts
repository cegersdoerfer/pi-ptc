import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SandboxManager, ExecutionOptions } from "./types";
import type { ToolRegistry } from "./tool-registry";
import { generateToolWrappers } from "./tool-wrapper";
import { RpcProtocol } from "./rpc-protocol";
import { truncateOutput, formatPythonError } from "./utils";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * CodeExecutor orchestrates Python code execution with RPC tool calling
 */
export class CodeExecutor {
  constructor(
    private sandboxManager: SandboxManager,
    private toolRegistry: ToolRegistry,
    private ctx: ExtensionContext
  ) {}

  async execute(userCode: string, options: ExecutionOptions): Promise<string> {
    const { cwd, signal, onUpdate } = options;

    // Get all available tools
    const allTools = this.toolRegistry.getAllTools();
    const toolsMap = new Map(allTools.map((t) => [t.name, t]));

    // Generate Python wrapper functions for all tools
    const toolWrappers = generateToolWrappers(allTools);

    // Read Python runtime files - try multiple possible locations
    let rpcCode: string;
    let runtimeCode: string;

    try {
      // Try dist/python-runtime first (for installed package)
      const distRuntimeDir = path.join(__dirname, "../src/python-runtime");
      rpcCode = fs.readFileSync(path.join(distRuntimeDir, "rpc.py"), "utf-8");
      runtimeCode = fs.readFileSync(path.join(distRuntimeDir, "runtime.py"), "utf-8");
    } catch {
      try {
        // Try src/python-runtime (for development)
        const srcRuntimeDir = path.join(__dirname, "python-runtime");
        rpcCode = fs.readFileSync(path.join(srcRuntimeDir, "rpc.py"), "utf-8");
        runtimeCode = fs.readFileSync(path.join(srcRuntimeDir, "runtime.py"), "utf-8");
      } catch (error) {
        throw new Error(
          `Failed to load Python runtime files: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Combine all code
    const combinedCode = `
${rpcCode}

${toolWrappers}

${runtimeCode}

# User code
async def user_main():
${userCode.split("\n").map(line => "    " + line).join("\n")}

# Execute
import asyncio
asyncio.run(_runtime_main(user_main))
`;

    // Spawn Python process
    const proc = spawn("python3", ["-u", "-c", combinedCode], {
      cwd,
      env: { ...process.env },
    });

    // Set up RPC protocol
    const rpc = new RpcProtocol(
      proc,
      toolsMap,
      async (toolName: string, params: any) => {
        return await this.toolRegistry.executeTool(toolName, params, this.ctx, signal);
      },
      userCode,
      signal,
      onUpdate
    );

    // Wait for completion
    try {
      const output = await rpc.waitForCompletion();
      return truncateOutput(output);
    } catch (error) {
      if (error instanceof Error) {
        // Check if this is a Python error with traceback
        if (error.message.includes("Python execution error")) {
          throw error;
        }
        throw new Error(formatPythonError(error.message));
      }
      throw error;
    }
  }
}
