import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SandboxManager, ExecutionOptions } from "./types";
import type { ToolRegistry } from "./tool-registry";
import { generateToolWrappers } from "./tool-wrapper";
import { RpcProtocol } from "./rpc-protocol";
import { truncateOutput, formatExecutionError } from "./utils";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * CodeExecutor orchestrates TypeScript code execution with RPC tool calling
 */
export class CodeExecutor {
  private tempFiles: string[] = [];

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

    // Generate TypeScript wrapper functions for all tools
    const toolWrappers = generateToolWrappers(allTools);

    // Read TypeScript runtime files - try multiple possible locations
    let rpcCode: string;
    let runtimeCode: string;

    try {
      // Try dist/ts-runtime first (for installed package)
      const distRuntimeDir = path.join(__dirname, "../src/ts-runtime");
      rpcCode = fs.readFileSync(path.join(distRuntimeDir, "rpc.ts"), "utf-8");
      runtimeCode = fs.readFileSync(path.join(distRuntimeDir, "runtime.ts"), "utf-8");
    } catch {
      try {
        // Try src/ts-runtime (for development)
        const srcRuntimeDir = path.join(__dirname, "ts-runtime");
        rpcCode = fs.readFileSync(path.join(srcRuntimeDir, "rpc.ts"), "utf-8");
        runtimeCode = fs.readFileSync(path.join(srcRuntimeDir, "runtime.ts"), "utf-8");
      } catch (error) {
        throw new Error(
          `Failed to load TypeScript runtime files: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Combine all code
    const userCodeLines = userCode.split("\n");
    const combinedCode = `
${rpcCode}

${toolWrappers}

${runtimeCode}

// User code
async function user_main() {
_reportProgress(1, ${userCodeLines.length});
${userCodeLines.map(line => "  " + line).join("\n")}
}

// Execute
_runtime_main(user_main);
`;

    // Write combined code to a temp file (tsx needs a file)
    const tempFile = path.join(os.tmpdir(), `ptc-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(tempFile, combinedCode);
    this.tempFiles.push(tempFile);

    // Debug: write a copy for inspection
    const debugFile = path.join(os.tmpdir(), "ptc-debug.ts");
    fs.writeFileSync(debugFile, combinedCode);

    try {
      // Spawn TypeScript process using sandbox manager
      const proc = this.sandboxManager.spawn(tempFile, cwd);

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
          if (error.message.includes("Execution error")) {
            throw error;
          }
          throw new Error(formatExecutionError(error.message));
        }
        throw error;
      }
    } finally {
      // Clean up temp file
      this.cleanupTempFile(tempFile);
    }
  }

  private cleanupTempFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
      this.tempFiles = this.tempFiles.filter(f => f !== filePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
