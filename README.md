# Programmatic Tool Calling (PTC) Extension for pi-coding-agent

An extension for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that enables Claude to write TypeScript code that calls tools as async functions, dramatically reducing token usage and latency for multi-tool workflows.

## Quick Start

```bash
git clone <this-repo> pi_PTC
cd pi_PTC
npm install
npm run build

# Link as a global extension
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/ptc
```

Restart pi-coding-agent. The `code_execution` tool is now available.

## Overview

**Problem**: Normally, when Claude needs to use multiple tools in sequence, each tool call requires a round-trip through the LLM:
1. Claude calls tool → returns result → Claude processes in context
2. Repeat for each tool call
3. All intermediate tool results consume context tokens and add latency

**Solution**: With PTC, Claude writes TypeScript code that calls tools as async functions. The code executes locally with only the final output returned to Claude.

### Benefits

- **Reduced Token Usage**: Intermediate tool results don't consume context
- **Lower Latency**: Single LLM round-trip instead of multiple
- **Complex Workflows**: Enable sophisticated multi-tool logic with loops, conditionals, and data aggregation
- **Optional Isolation**: Docker containers available for additional security (opt-in)
- **Optional Type Checking**: Enable compile-time type checking via `PTC_TYPE_CHECK=true`

## Prerequisites

- Node.js 18+
- [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) installed
- Docker (optional, see [Execution Modes](#execution-modes) below)

## Installation

1. Clone and build:
   ```bash
   git clone <this-repo> pi_PTC
   cd pi_PTC
   npm install
   npm run build
   ```

2. Link as a pi-coding-agent extension:
   ```bash
   # Option 1: Global extension (all projects)
   mkdir -p ~/.pi/agent/extensions
   ln -s /path/to/pi_PTC ~/.pi/agent/extensions/ptc

   # Option 2: Project-specific extension
   mkdir -p /path/to/project/.pi/extensions
   ln -s /path/to/pi_PTC /path/to/project/.pi/extensions/ptc
   ```

3. Restart pi-coding-agent — the extension will be auto-discovered.

## Available Tools

By default, TypeScript code running in PTC has access to pi-coding-agent's **built-in tools only** (e.g. `glob`, `read`, `bash`). Tools from other pi extensions are **not** available — the pi extensions API does not currently support extensions exposing tools to each other.

If you need additional tools available in the PTC environment, you must add them as custom tools in the `tools/` directory. See [Custom Tools](#custom-tools) for details.

## Usage

Once installed, Claude can use the `code_execution` tool to run TypeScript code with tool calling. Any tool available in the PTC environment — both pi's built-in tools and your [custom tools](#custom-tools) — can be called as an async TypeScript function.

The real power of PTC is orchestrating **custom tools** in ways that would otherwise require many LLM round-trips. Pi's built-in tools (`glob`, `read`, `bash`) are also available but can often be replaced with standard Node.js.

### Example: Multi-step API workflow

Suppose you have custom tools `query_db` and `send_notification` registered in `tools/`:

```typescript
// Fetch all overdue orders and notify their owners — single LLM round-trip
const orders = await query_db({ sql: "SELECT id, owner_email FROM orders WHERE due < NOW() AND status = 'pending'" });

let notified = 0;
for (const order of orders) {
  await send_notification({
    to: order.owner_email,
    subject: `Order #${order.id} is overdue`,
    body: "Please review your order status.",
  });
  notified++;
}

return `Notified ${notified} owners about overdue orders`;
```

Without PTC, Claude would need a separate LLM round-trip for each `query_db` and `send_notification` call, consuming context tokens on every intermediate result.

### Example: Aggregating results from a custom tool

```typescript
// Custom tool "get_weather" registered in tools/
const cities = ["London", "Tokyo", "New York", "Sydney"];
const results: string[] = [];

for (const city of cities) {
  const weather = await get_weather({ location: city });
  results.push(`${city}: ${weather}`);
}

return results.join("\n");
```

### Example: Mixing custom tools with built-in tools

```typescript
// Use built-in glob/read to find config, then pass to a custom tool
const config = await read({ file_path: "deploy.yaml" });
const result = await deploy_service({ config, environment: "staging" });
return `Deploy result: ${result}`;
```

### Example: Conditional logic with custom tools

```typescript
const status = await check_service_health({ service: "api" });

if (status.includes("healthy")) {
  return "All services healthy";
} else {
  // Restart and re-check
  await restart_service({ service: "api" });
  const recheck = await check_service_health({ service: "api" });
  return `Restarted api — now ${recheck.includes("healthy") ? "healthy" : "still unhealthy"}`;
}
```

## Custom Tools

Drop `.js` files in the `tools/` directory to register additional tools. These become available both as direct pi-coding-agent tools and as async functions inside `code_execution` TypeScript code.

See `tools/get_weather.js.example` for a complete example:

```bash
cp tools/get_weather.js.example tools/get_weather.js
```

Each file should default-export an object with:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Tool name (becomes the TypeScript function name) |
| `label` | no | Display label |
| `description` | yes | Description shown to the model |
| `parameters` | yes | JSON Schema object describing the tool's parameters |
| `execute` | yes | `async (toolCallId, params, signal) => result` |

Only `.js` files are loaded — `.ts`, `.example`, etc. are ignored. Files are loaded at extension startup; restart pi-coding-agent after adding new tools.

## How It Works

### Architecture

```
User: "Analyze all TypeScript files and find bugs"
  ↓
LLM generates TypeScript code:
  const files = await glob({ pattern: "**/*.ts" });
  for (const file of files.split("\n")) {
      const content = await read({ file_path: file });
      // analyze content...
  }
  ↓
code_execution tool called with TypeScript code
  ↓
Extension:
  1. Gets available tools from pi-coding-agent
  2. Generates TypeScript wrapper functions
  3. Combines wrappers + user code
  4. Starts TypeScript process (tsx subprocess or Docker)
  ↓
TypeScript Runtime:
  1. Executes user code
  2. When calling a tool: sends RPC message to Node.js
  3. Node.js executes actual tool
  4. Result returned to TypeScript
  5. TypeScript continues execution
  ↓
Extension returns final output to LLM
```

### Components

- **Extension (`src/index.ts`)**: Registers `code_execution` tool
- **Sandbox Manager (`src/sandbox-manager.ts`)**: Manages Docker containers or tsx subprocesses
- **Code Executor (`src/code-executor.ts`)**: Orchestrates TypeScript code execution
- **Tool Wrapper Generator (`src/tool-wrapper.ts`)**: Converts tool definitions to TypeScript async functions
- **RPC Protocol (`src/rpc-protocol.ts` + `src/ts-runtime/rpc.ts`)**: JSON-based communication between host Node.js and subprocess
- **TypeScript Runtime (`src/ts-runtime/runtime.ts`)**: Subprocess execution environment
- **Tool Loader (`src/tool-loader.ts`)**: Discovers and loads custom tools from `tools/`

### Execution Modes

The extension runs TypeScript code in a local subprocess by default. Docker isolation is available as an opt-in feature.

**Subprocess mode** (default):

- Spawns a `tsx` subprocess in the current working directory
- No additional isolation beyond subprocess boundaries
- Simple setup with no external dependencies beyond Node.js
- Suitable for trusted environments where you control the code generation

**Docker mode** (opt-in):

To enable Docker isolation, set the environment variable:
```bash
export PTC_USE_DOCKER=true
```

Then ensure Docker is installed and running:
```bash
# Verify Docker is available
docker --version
docker ps

# Pull the Node.js image (optional, avoids slow first run)
docker pull node:22-slim
```

When enabled, the TypeScript code is transpiled to JavaScript on the host, then each execution runs inside a container with:
- **Network disabled** (`--network none`) — code cannot make outbound requests
- **Workspace mounted read-only** (`-v "$CWD:/workspace:ro"`)
- **Resource limits**: 512 MB RAM, 1 CPU
- **Container reuse**: Same container used for multiple executions within 4.5 minutes

**Note**: Docker isolation provides defense-in-depth but doesn't prevent malicious code from using tools (like `bash`) to affect your system, since tool execution happens on the host via RPC.

### Type Checking

To enable optional compile-time type checking before execution:
```bash
export PTC_TYPE_CHECK=true
```

When enabled, TypeScript code is checked for type errors before execution. Any type errors are returned to the agent without running the code.

### Execution Limits

- **Timeout**: 4.5 minutes (270 seconds)
- **Max Output**: 100 KB (automatically truncated with notice)
- **Cancellation**: Supports abort signals (Ctrl+C)

## Development

### Building

```bash
npm run build      # Compile TypeScript
npm run watch      # Watch mode for development
npm run clean      # Remove build artifacts
```

### Project Structure

```
pi_PTC/
├── src/
│   ├── index.ts              # Extension entry point
│   ├── sandbox-manager.ts    # Container/subprocess management
│   ├── code-executor.ts      # Execution orchestration
│   ├── tool-wrapper.ts       # TypeScript wrapper generation
│   ├── tool-loader.ts        # Custom tool discovery
│   ├── rpc-protocol.ts       # RPC (host Node.js side)
│   ├── utils.ts              # Utilities
│   ├── types.ts              # TypeScript types
│   └── ts-runtime/
│       ├── runtime.ts        # Subprocess execution entry
│       └── rpc.ts            # RPC (subprocess side)
├── tools/                    # Custom tool definitions (.js files)
├── dist/                     # Compiled output (git-ignored)
├── package.json
└── tsconfig.json
```

## Troubleshooting

### Extension not loading

1. Check pi-coding-agent recognizes the extension:
   ```bash
   pi --list-extensions
   ```

2. Verify symlink is correct:
   ```bash
   ls -l ~/.pi/agent/extensions/ptc
   ```

3. Check build succeeded:
   ```bash
   ls dist/
   ```

### TypeScript execution fails

1. Verify Node.js 18+ is available:
   ```bash
   node --version
   ```

2. Verify tsx is installed (should be via npm install):
   ```bash
   npx tsx --version
   ```

3. If using Docker, check Docker is running:
   ```bash
   docker --version
   docker ps
   ```

4. Check logs for detailed error messages

### Tool calls fail from TypeScript

1. Verify tool name matches exactly (check `pi.getAllTools()`)
2. Check parameter types match schema
3. Look for RPC protocol errors in output

### Timeout issues

For long-running operations:
- Break into smaller chunks
- Use progress updates: `console.log(\`Processed ${i}/${total}\`)`
- Consider if PTC is the right approach (very long operations might be better as separate tool calls)

## FAQ

**Q: Can I use external npm packages?**
A: Not by default. The execution environment only includes Node.js standard library. Future versions may support npm package installation.

**Q: Can I call pi-coding-agent tools from nested functions?**
A: Yes! All tool wrapper functions are async and can be called from any async context in your code.

**Q: What happens if my code has a syntax error?**
A: TypeScript/tsx will raise an error which will be returned to Claude with the full stack trace for debugging.

**Q: Can I use Worker threads?**
A: Yes, but keep in mind the 4.5 minute timeout applies to the entire execution.

**Q: How do I debug my TypeScript code?**
A: Use `console.log()` statements — they'll be captured and included in the output.

**Q: What's the overhead of PTC vs direct tool calls?**
A: Slight overhead for a single tool call, but massive savings for 3+ sequential calls.

**Q: Why can't I use tools from other pi extensions?**
A: The pi extensions API does not currently support extensions exposing tools to each other. If you need a tool available in PTC, add it as a custom tool in the `tools/` directory.

## License

MIT

## Contributing

Contributions welcome! Please open an issue to discuss major changes before submitting a PR.
