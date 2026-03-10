import type { ToolDefinition, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "./types";

/**
 * Create built-in tool instances with working execute functions.
 * The factory functions from pi-coding-agent return AgentTool objects
 * with a 4-arg execute signature; we wrap them to match the 5-arg
 * ToolDefinition.execute signature used by our ToolInfo type.
 */
function createBuiltinTools(cwd: string): Map<string, ToolInfo> {
  const factories = [
    createReadTool,
    createBashTool,
    createEditTool,
    createWriteTool,
    createGrepTool,
    createFindTool,
    createLsTool,
  ];

  const builtins = new Map<string, ToolInfo>();
  for (const factory of factories) {
    const agentTool = factory(cwd);
    builtins.set(agentTool.name, {
      name: agentTool.name,
      description: agentTool.description,
      parameters: agentTool.parameters,
      // Wrap 4-arg AgentTool.execute to match 5-arg ToolDefinition.execute
      execute: (toolCallId, params, signal, onUpdate, _ctx) =>
        (agentTool as any).execute(toolCallId, params, signal, onUpdate),
    });
  }
  return builtins;
}

/**
 * Registry for tracking registered tools and their execute functions
 */
export class ToolRegistry {
  private tools = new Map<string, ToolInfo>();
  private originalRegisterTool: ExtensionAPI["registerTool"];

  constructor(private pi: ExtensionAPI) {
    // Store the original registerTool method
    this.originalRegisterTool = pi.registerTool.bind(pi);

    // Intercept tool registrations to build our registry
    pi.registerTool = this.interceptRegisterTool.bind(this);
  }

  private interceptRegisterTool(tool: ToolDefinition<any, any>): void {
    // Store the tool with its execute function
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    });

    // Call the original registerTool
    this.originalRegisterTool(tool);
  }

  /**
   * Remove a tool from the registry by name
   */
  removeTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get all registered tools with working execute functions.
   * Merges: intercepted extension tools + factory-created built-in tools + pi tool metadata.
   */
  getAllTools(cwd?: string): ToolInfo[] {
    const piTools = this.pi.getAllTools();
    const builtins = cwd ? createBuiltinTools(cwd) : new Map<string, ToolInfo>();
    const allTools = new Map<string, ToolInfo>();

    // Add tools from pi metadata, using factory-created builtins for execute
    for (const piTool of piTools) {
      const builtin = builtins.get(piTool.name);
      if (builtin) {
        allTools.set(piTool.name, builtin);
      } else {
        allTools.set(piTool.name, {
          name: piTool.name,
          description: piTool.description,
          parameters: piTool.parameters,
          execute: (piTool as any).execute || (async () => {
            throw new Error(`Tool ${piTool.name} execute function not available`);
          }),
        });
      }
    }

    // Override with our intercepted tools (extension-registered tools with execute)
    for (const [name, tool] of this.tools.entries()) {
      allTools.set(name, tool);
    }

    return Array.from(allTools.values());
  }

  /**
   * Execute a tool by name
   */
  async executeTool(
    toolName: string,
    params: any,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    cwd?: string
  ): Promise<any> {
    let tool = this.tools.get(toolName);

    // Fall back to factory-created built-in tools
    if (!tool && cwd) {
      const builtins = createBuiltinTools(cwd);
      const builtin = builtins.get(toolName);
      if (builtin) {
        tool = builtin;
        // Cache for future calls
        this.tools.set(toolName, tool);
      }
    }

    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}. Available: ${Array.from(this.tools.keys()).join(', ')}`);
    }

    // Generate a unique tool call ID
    const toolCallId = `ptc_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Execute the tool
    return await tool.execute(toolCallId, params, signal, undefined, ctx);
  }
}
