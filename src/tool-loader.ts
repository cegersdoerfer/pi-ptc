import * as fs from "fs";
import * as path from "path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export interface CustomToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: any;
  execute: ToolDefinition<any, any>["execute"];
}

/**
 * Load custom tool definitions from the tools/ directory.
 * Each .js file should have a default export matching CustomToolDefinition.
 */
export async function loadTools(extensionRoot: string): Promise<CustomToolDefinition[]> {
  const toolsDir = path.join(extensionRoot, "tools");

  if (!fs.existsSync(toolsDir)) {
    return [];
  }

  const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".js"));

  if (files.length === 0) {
    return [];
  }

  const tools: CustomToolDefinition[] = [];

  for (const file of files) {
    const filePath = path.join(toolsDir, file);
    try {
      const mod = await import(filePath);
      const def = mod.default || mod;

      if (!def.name || !def.execute || !def.parameters) {
        console.warn(
          `[PTC] Skipping ${file}: missing required fields (name, execute, parameters)`
        );
        continue;
      }

      tools.push(def);
      console.log(`[PTC] Loaded custom tool: ${def.name}`);
    } catch (err) {
      console.warn(`[PTC] Failed to load tool from ${file}:`, err);
    }
  }

  if (tools.length > 0) {
    console.log(`[PTC] ${tools.length} custom tool(s) loaded from tools/`);
  }

  return tools;
}
