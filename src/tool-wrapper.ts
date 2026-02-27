import type { TSchema } from "@sinclair/typebox";
import type { ToolInfo } from "./types";

/**
 * Convert TypeBox schema to Python type hint
 */
function schemaToPythonType(schema: TSchema): string {
  const kind = (schema as any).type;

  switch (kind) {
    case "string":
      return "str";
    case "number":
      return "float";
    case "integer":
      return "int";
    case "boolean":
      return "bool";
    case "array":
      const items = (schema as any).items;
      const itemType = items ? schemaToPythonType(items) : "Any";
      return `List[${itemType}]`;
    case "object":
      return "Dict[str, Any]";
    case "null":
      return "None";
    default:
      return "Any";
  }
}

/**
 * Check if a schema represents an optional parameter
 */
function isOptional(schema: TSchema): boolean {
  // Check for TypeBox Optional or anyOf with null
  if ((schema as any).anyOf) {
    const anyOf = (schema as any).anyOf as TSchema[];
    return anyOf.some((s: any) => s.type === "null");
  }
  return false;
}

/**
 * Extract the non-null schema from an optional type
 */
function extractNonNullSchema(schema: TSchema): TSchema {
  if ((schema as any).anyOf) {
    const anyOf = (schema as any).anyOf as TSchema[];
    const nonNull = anyOf.find((s: any) => s.type !== "null");
    return nonNull || schema;
  }
  return schema;
}

/**
 * Generate a Python function wrapper for a single tool
 */
function generateToolWrapper(tool: ToolInfo): string {
  const { name, description, parameters } = tool;
  const params = (parameters as any)?.properties || {};
  const required = new Set((parameters as any)?.required || []);

  // Build parameter list
  const paramList: string[] = [];
  const paramDocs: string[] = [];

  for (const [paramName, paramSchema] of Object.entries(params)) {
    const schema = paramSchema as TSchema;
    const isOpt = !required.has(paramName) || isOptional(schema);
    const actualSchema = isOptional(schema) ? extractNonNullSchema(schema) : schema;
    const pythonType = schemaToPythonType(actualSchema);

    // Build parameter signature
    if (isOpt) {
      paramList.push(`${paramName}: Optional[${pythonType}] = None`);
    } else {
      paramList.push(`${paramName}: ${pythonType}`);
    }

    // Build parameter documentation
    const desc = (schema as any).description || "";
    paramDocs.push(`        ${paramName}: ${desc}`);
  }

  // Separate required and optional params (required first)
  const requiredParams = paramList.filter(p => !p.includes("= None"));
  const optionalParams = paramList.filter(p => p.includes("= None"));

  // Build function signature
  let signature = `async def ${name}(`;
  if (requiredParams.length > 0) {
    signature += `\n    ${requiredParams.join(",\n    ")}`;
    if (optionalParams.length > 0) {
      signature += ",\n    *,\n    " + optionalParams.join(",\n    ");
    }
  } else if (optionalParams.length > 0) {
    signature += `\n    *,\n    ${optionalParams.join(",\n    ")}`;
  }
  signature += "\n) -> str:";

  // Build docstring
  const desc = description || `Execute ${name} tool`;
  const docstring = `    """
    ${desc.split("\n").join("\n    ")}

${paramDocs.length > 0 ? "    Args:\n" + paramDocs.join("\n") + "\n" : ""}
    Returns:
        The tool result as a string
    """`;

  // Build function body
  const paramsDict = Object.keys(params).length > 0
    ? `{\n${Object.keys(params).map(p => `        "${p}": ${p}`).join(",\n")},\n    }`
    : "{}";

  const body = `    result = await _rpc_call("${name}", ${paramsDict})
    # Extract text from content array
    if isinstance(result, list):
        return "".join(c.get("text", "") for c in result if isinstance(c, dict) and c.get("type") == "text")
    return str(result)`;

  return `${signature}\n${docstring}\n${body}`;
}

/**
 * Generate Python wrapper functions for all tools
 */
export function generateToolWrappers(tools: ToolInfo[]): string {
  const imports = `from typing import Optional, List, Dict, Any, Union`;

  const wrappers = tools
    .map((tool) => generateToolWrapper(tool))
    .join("\n\n");

  return `${imports}\n\n${wrappers}`;
}
