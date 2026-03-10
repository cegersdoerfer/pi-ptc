import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SandboxManager, ExecutionOptions } from "./types";
import type { ToolRegistry } from "./tool-registry";
import { generateToolWrappers } from "./tool-wrapper";
import { RpcProtocol } from "./rpc-protocol";
import { truncateOutput, formatExecutionError } from "./utils";
import { typeCheckCode } from "./type-checker";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Built-in agent tools that are implemented natively in the subprocess
// (the agent framework doesn't expose execute functions for these to extensions)
const BUILTIN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

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
    const toolsMap = new Map(allTools.filter((t) => !BUILTIN_TOOL_NAMES.has(t.name)).map((t) => [t.name, t]));

    // Generate TypeScript RPC wrapper functions for extension tools only
    // (built-in tools are provided as native implementations via builtins.ts)
    const toolWrappers = generateToolWrappers(allTools.filter((t) => !BUILTIN_TOOL_NAMES.has(t.name)));

    // Read TypeScript runtime files - try multiple possible locations
    let rpcCode: string;
    let runtimeCode: string;
    let builtinsCode: string;

    try {
      // Try dist/ts-runtime first (for installed package)
      const distRuntimeDir = path.join(__dirname, "../src/ts-runtime");
      rpcCode = fs.readFileSync(path.join(distRuntimeDir, "rpc.ts"), "utf-8");
      runtimeCode = fs.readFileSync(path.join(distRuntimeDir, "runtime.ts"), "utf-8");
      builtinsCode = fs.readFileSync(path.join(distRuntimeDir, "builtins.ts"), "utf-8");
    } catch {
      try {
        // Try src/ts-runtime (for development)
        const srcRuntimeDir = path.join(__dirname, "ts-runtime");
        rpcCode = fs.readFileSync(path.join(srcRuntimeDir, "rpc.ts"), "utf-8");
        runtimeCode = fs.readFileSync(path.join(srcRuntimeDir, "runtime.ts"), "utf-8");
        builtinsCode = fs.readFileSync(path.join(srcRuntimeDir, "builtins.ts"), "utf-8");
      } catch (error) {
        throw new Error(
          `Failed to load TypeScript runtime files: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Combine all code in parts to track user code line offsets
    const userCodeLines = userCode.split("\n");

    const prefix = `
${builtinsCode}

${rpcCode}

${toolWrappers}

${runtimeCode}

// User code
async function user_main() {
_reportProgress(1, ${userCodeLines.length});
`;

    const userSection = userCodeLines.map(line => "  " + line).join("\n");

    const suffix = `
}

// Execute
_runtime_main(user_main);
`;

    const combinedCode = prefix + userSection + suffix;

    // Compute 1-based line numbers for the user code section
    const prefixLineCount = prefix.split("\n").length;
    const userCodeStartLine = prefixLineCount;
    const userCodeEndLine = userCodeStartLine + userCodeLines.length - 1;

    // Write combined code to a temp file (tsx needs a file)
    const tempFile = path.join(os.tmpdir(), `ptc-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(tempFile, combinedCode);
    this.tempFiles.push(tempFile);

    // Debug: write a copy for inspection
    const debugFile = path.join(os.tmpdir(), "ptc-debug.ts");
    fs.writeFileSync(debugFile, combinedCode);

    // Optional pre-execution type checking
    if (process.env.PTC_TYPE_CHECK === "true") {
      const result = typeCheckCode(tempFile, combinedCode, userCodeStartLine, userCodeEndLine);
      if (!result.success) {
        this.cleanupTempFile(tempFile);
        return `Type check failed with ${result.errors.length} error(s):\n\n${result.errors.join("\n")}`;
      }
    }

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
