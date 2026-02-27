import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { CodeExecutor } from "./code-executor";
import { createSandbox } from "./sandbox-manager";
import { ToolRegistry } from "./tool-registry";
import { loadTools } from "./tool-loader";
import type { SandboxManager, ExecutionDetails } from "./types";

let sandboxManager: SandboxManager | null = null;
let codeExecutor: CodeExecutor | null = null;
let toolRegistry: ToolRegistry | null = null;

/**
 * Render Python code with current line highlighting during execution
 */
function renderExecutingCode(
  codeLines: string[],
  currentLine: number,
  totalLines: number,
  theme: Theme
): Component {
  const lines: string[] = [];

  // Header
  lines.push(theme.fg("muted", `Executing Python code (line ${currentLine}/${totalLines}):`));
  lines.push("");

  // Show code with line numbers and highlight
  codeLines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const isCurrentLine = lineNum === currentLine;

    let prefix = `${String(lineNum).padStart(3, " ")} │ `;
    let content = line;

    if (isCurrentLine) {
      // Highlight current line with arrow
      prefix = theme.fg("success", `→ ${String(lineNum).padStart(2, " ")} │ `);
      content = theme.fg("text", line);
    } else if (lineNum < currentLine) {
      // Already executed - muted
      prefix = theme.fg("muted", prefix);
      content = theme.fg("muted", line);
    } else {
      // Not yet executed - normal
      prefix = theme.fg("muted", prefix);
    }

    lines.push(prefix + content);
  });

  return new Text(lines.join("\n"), 0, 0);
}

/**
 * PTC (Programmatic Tool Calling) Extension
 * Enables Claude to write Python code that calls tools as async functions
 */
export default async function ptcExtension(pi: ExtensionAPI, context: ExtensionContext) {
  // Initialize tool registry (intercepts tool registrations)
  toolRegistry = new ToolRegistry(pi);

  // Initialize sandbox manager (will try Docker first, fallback to subprocess)
  sandboxManager = await createSandbox();
  codeExecutor = new CodeExecutor(sandboxManager, toolRegistry, context);

  // Load and register custom tools from tools/ directory
  const extensionRoot = __dirname.endsWith("/dist") || __dirname.endsWith("\\dist")
    ? __dirname.replace(/[/\\]dist$/, "")
    : __dirname;
  const customTools = await loadTools(extensionRoot);
  for (const tool of customTools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label || tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    });
  }

  // Register the code_execution tool
  pi.registerTool({
    name: "code_execution",
    label: "Code Execution",
    description: `Execute Python code with async tool calling support.

This tool allows you to write Python code that calls other tools as async functions. All available tools are exposed as Python async functions that you can await.

Example:
\`\`\`python
# Read and analyze files
files = await glob(pattern="**/*.ts")
for file_path in files[:5]:
    content = await read(file_path=file_path)
    if "TODO" in content:
        print(f"Found TODO in {file_path}")
\`\`\`

Key features:
- All tools available as async Python functions
- Multi-tool workflows execute in a single round-trip
- Reduced token usage and latency
- Isolated execution environment (Docker or subprocess)
- 4.5 minute timeout

The code runs in an isolated Python 3.12 environment. Use standard Python libraries and async/await syntax.`,
    parameters: Type.Object({
      code: Type.String({
        description: "Python code to execute. Can use await to call any available tool.",
      }),
    }),
    execute: async (toolCallId, { code }, signal, onUpdate, ctx) => {
      if (!codeExecutor) {
        throw new Error("Code executor not initialized");
      }

      try {
        const output = await codeExecutor.execute(code, {
          cwd: ctx.cwd,
          signal,
          onUpdate,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: output || "(No output)",
            },
          ],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Python execution failed: ${message}`);
      }
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as ExecutionDetails | undefined;

      // During execution, show code with current line highlighted
      if (isPartial && details?.userCode && details.currentLine) {
        return renderExecutingCode(
          details.userCode,
          details.currentLine,
          details.totalLines || details.userCode.length,
          theme
        );
      }

      // After execution completes, show final output
      const text = result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      return new Text(text || "(No output)", 0, 0);
    },
  });

  // Register cleanup on session shutdown
  pi.on("session_shutdown", async () => {
    if (sandboxManager) {
      await sandboxManager.cleanup();
      sandboxManager = null;
    }
    codeExecutor = null;
    toolRegistry = null;
  });
}
