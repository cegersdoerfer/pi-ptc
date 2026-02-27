/**
 * Utility functions for the PTC extension
 */

const MAX_OUTPUT_SIZE = 100_000; // 100KB max output

/**
 * Truncate output if it exceeds the maximum size
 */
export function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return output;
  }

  const truncated = output.substring(0, MAX_OUTPUT_SIZE);
  const truncationNotice = `\n\n[Output truncated - showing first ${MAX_OUTPUT_SIZE} characters of ${output.length}]`;
  return truncated + truncationNotice;
}

/**
 * Format a Python exception for display
 */
export function formatPythonError(message: string, traceback?: string): string {
  if (traceback) {
    return `Python execution error:\n${message}\n\nTraceback:\n${traceback}`;
  }
  return `Python execution error: ${message}`;
}

/**
 * Sanitize parameters for logging (remove sensitive data)
 */
export function sanitizeParams(params: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    // Truncate long string values
    if (typeof value === "string" && value.length > 200) {
      sanitized[key] = value.substring(0, 200) + "... (truncated)";
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
