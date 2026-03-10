import type { TSchema } from "@sinclair/typebox";
import type { ToolInfo } from "./types";

/**
 * Convert TypeBox schema to TypeScript type annotation
 */
function schemaToTsType(schema: TSchema): string {
  const kind = (schema as any).type;

  switch (kind) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const items = (schema as any).items;
      const itemType = items ? schemaToTsType(items) : "any";
      return `${itemType}[]`;
    }
    case "object":
      return "Record<string, any>";
    case "null":
      return "null";
    default:
      return "any";
  }
}

/**
 * Check if a schema represents an optional parameter
 */
function isOptional(schema: TSchema): boolean {
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
 * Generate a TypeScript async function wrapper for a single tool
 */
function generateToolWrapper(tool: ToolInfo): string {
  const { name, description, parameters } = tool;
  const params = (parameters as any)?.properties || {};
  const required = new Set((parameters as any)?.required || []);

  // Build parameter interface fields
  const paramFields: string[] = [];

  for (const [paramName, paramSchema] of Object.entries(params)) {
    const schema = paramSchema as TSchema;
    const isOpt = !required.has(paramName) || isOptional(schema);
    const actualSchema = isOptional(schema) ? extractNonNullSchema(schema) : schema;
    const tsType = schemaToTsType(actualSchema);

    if (isOpt) {
      paramFields.push(`${paramName}?: ${tsType}`);
    } else {
      paramFields.push(`${paramName}: ${tsType}`);
    }
  }

  // Build function
  const paramsType = paramFields.length > 0
    ? `params: { ${paramFields.join("; ")} }`
    : "";

  const rpcParams = paramFields.length > 0 ? "params" : "{}";

  const desc = description || `Execute ${name} tool`;
  const safeDesc = desc.split("\n")[0].replace(/\*\//g, "* /");
  const docComment = `/** ${safeDesc} */`;

  return `${docComment}
async function ${name}(${paramsType}): Promise<string> {
  const result = await _rpc_call("${name}", ${rpcParams});
  if (Array.isArray(result)) {
    return result.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
  }
  return String(result);
}`;
}

/**
 * Generate TypeScript wrapper functions for all tools
 */
export function generateToolWrappers(tools: ToolInfo[]): string {
  const wrappers = tools
    .map((tool) => generateToolWrapper(tool))
    .join("\n\n");

  return wrappers;
}
