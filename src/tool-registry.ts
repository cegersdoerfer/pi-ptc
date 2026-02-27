import type { ToolDefinition, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "./types";

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
   * Get all registered tools
   */
  getAllTools(): ToolInfo[] {
    // Combine our registered tools with pi.getAllTools()
    const piTools = this.pi.getAllTools();
    const allTools = new Map<string, ToolInfo>();

    // Add tools from pi - preserve execute functions if they exist
    for (const piTool of piTools) {
      const toolInfo: ToolInfo = {
        name: piTool.name,
        description: piTool.description,
        parameters: piTool.parameters,
        execute: (piTool as any).execute || (async () => {
          throw new Error(`Tool ${piTool.name} execute function not available`);
        }),
      };
      allTools.set(piTool.name, toolInfo);

      // If this tool wasn't intercepted but has an execute function, store it in our registry
      if (!this.tools.has(piTool.name) && (piTool as any).execute) {
        this.tools.set(piTool.name, toolInfo);
      }
    }

    // Override with our stored execute functions (for intercepted tools)
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
    signal?: AbortSignal
  ): Promise<any> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}. Available: ${Array.from(this.tools.keys()).join(', ')}`);
    }

    // Generate a unique tool call ID
    const toolCallId = `ptc_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Execute the tool
    return await tool.execute(toolCallId, params, signal, undefined, ctx);
  }
}
