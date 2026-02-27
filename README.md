# Programmatic Tool Calling (PTC) Extension for pi-coding-agent

An extension for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that enables Claude to write Python code that calls tools as async functions, dramatically reducing token usage and latency for multi-tool workflows.

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

**Solution**: With PTC, Claude writes Python code that calls tools as async functions. The code executes locally with only the final output returned to Claude.

### Benefits

- **Reduced Token Usage**: Intermediate tool results don't consume context
- **Lower Latency**: Single LLM round-trip instead of multiple
- **Complex Workflows**: Enable sophisticated multi-tool logic with loops, conditionals, and data aggregation
- **Isolation**: Runs in Docker containers (or subprocess fallback) for security

## Prerequisites

- Node.js 18+
- Python 3.12+ (must be available as `python3`)
- [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) installed
- Docker (optional, see [Docker Isolation](#docker-isolation) below)

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

By default, Python code running in PTC has access to pi-coding-agent's **built-in tools only** (e.g. `glob`, `read`, `bash`). Tools from other pi extensions are **not** available — the pi extensions API does not currently support extensions exposing tools to each other.

If you need additional tools available in the PTC environment, you must add them as custom tools in the `tools/` directory. See [Custom Tools](#custom-tools) for details.

## Usage

Once installed, Claude can use the `code_execution` tool to run Python code with tool calling. Any tool available in the PTC environment — both pi's built-in tools and your [custom tools](#custom-tools) — can be called as an async Python function.

The real power of PTC is orchestrating **custom tools** in ways that would otherwise require many LLM round-trips. Pi's built-in tools (`glob`, `read`, `bash`) are also available but can often be replaced with standard Python.

### Example: Multi-step API workflow

Suppose you have custom tools `query_db` and `send_notification` registered in `tools/`:

```python
# Fetch all overdue orders and notify their owners — single LLM round-trip
orders = await query_db(sql="SELECT id, owner_email FROM orders WHERE due < NOW() AND status = 'pending'")

notified = 0
for order in orders:
    await send_notification(
        to=order["owner_email"],
        subject=f"Order #{order['id']} is overdue",
        body="Please review your order status."
    )
    notified += 1

return f"Notified {notified} owners about overdue orders"
```

Without PTC, Claude would need a separate LLM round-trip for each `query_db` and `send_notification` call, consuming context tokens on every intermediate result.

### Example: Aggregating results from a custom tool

```python
# Custom tool "get_weather" registered in tools/
cities = ["London", "Tokyo", "New York", "Sydney"]
results = []

for city in cities:
    weather = await get_weather(location=city)
    results.append(f"{city}: {weather}")

return "\n".join(results)
```

### Example: Mixing custom tools with built-in tools

```python
# Use built-in glob/read to find config, then pass to a custom tool
config = await read(file_path="deploy.yaml")
result = await deploy_service(config=config, environment="staging")
return f"Deploy result: {result}"
```

### Example: Conditional logic with custom tools

```python
status = await check_service_health(service="api")

if status["healthy"]:
    return "All services healthy"
else:
    # Restart and re-check
    await restart_service(service="api")
    recheck = await check_service_health(service="api")
    return f"Restarted api — now {'healthy' if recheck['healthy'] else 'still unhealthy'}"
```

## Custom Tools

Drop `.js` files in the `tools/` directory to register additional tools. These become available both as direct pi-coding-agent tools and as async functions inside `code_execution` Python code.

See `tools/get_weather.js.example` for a complete example:

```bash
cp tools/get_weather.js.example tools/get_weather.js
```

Each file should default-export an object with:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Tool name (becomes the Python function name) |
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
LLM generates Python code:
  files = await glob(pattern="**/*.ts")
  for file in files:
      content = await read(file_path=file)
      # analyze content...
  ↓
code_execution tool called with Python code
  ↓
Extension:
  1. Gets available tools from pi-coding-agent
  2. Generates Python wrapper functions
  3. Combines wrappers + user code
  4. Starts Python process (Docker or subprocess)
  ↓
Python Runtime:
  1. Executes user code
  2. When calling a tool: sends RPC message to Node.js
  3. Node.js executes actual tool
  4. Result returned to Python
  5. Python continues execution
  ↓
Extension returns final output to LLM
```

### Components

- **Extension (`src/index.ts`)**: Registers `code_execution` tool
- **Sandbox Manager (`src/sandbox-manager.ts`)**: Manages Docker containers or Python subprocesses
- **Code Executor (`src/code-executor.ts`)**: Orchestrates Python code execution
- **Tool Wrapper Generator (`src/tool-wrapper.ts`)**: Converts tool definitions to Python async functions
- **RPC Protocol (`src/rpc-protocol.ts` + `src/python-runtime/rpc.py`)**: JSON-based communication between Node.js and Python
- **Python Runtime (`src/python-runtime/runtime.py`)**: Python execution environment
- **Tool Loader (`src/tool-loader.ts`)**: Discovers and loads custom tools from `tools/`

### Docker Isolation

The extension automatically detects whether Docker is available. If it is, code runs in an isolated container. Otherwise it falls back to a local subprocess.

**Docker mode** (preferred):

- Requires Docker to be installed and the daemon running (`docker --version` and `docker ps` should both succeed)
- Uses the `python:3.12-slim` image — pull it ahead of time to avoid a slow first run:
  ```bash
  docker pull python:3.12-slim
  ```
- Each execution runs inside a container with:
  - **Network disabled** (`--network none`) — code cannot make outbound requests
  - **Workspace mounted read-only** (`-v "$CWD:/workspace:ro"`)
  - **Resource limits**: 512 MB RAM, 1 CPU
- Containers are reused across executions for lower latency and automatically cleaned up after 4.5 minutes of inactivity

**Subprocess mode** (fallback):

- Used automatically when Docker is not available
- Spawns a `python3` subprocess in the current working directory
- No network or filesystem isolation — suitable for trusted environments

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
│   ├── tool-wrapper.ts       # Python wrapper generation
│   ├── tool-loader.ts        # Custom tool discovery
│   ├── rpc-protocol.ts       # RPC (Node.js side)
│   ├── utils.ts              # Utilities
│   ├── types.ts              # TypeScript types
│   └── python-runtime/
│       ├── runtime.py        # Python execution entry
│       └── rpc.py            # RPC (Python side)
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

### Python execution fails

1. Verify Python 3.12+ is available:
   ```bash
   python3 --version
   ```

2. If using Docker, check Docker is running:
   ```bash
   docker --version
   docker ps
   ```

3. Check logs for detailed error messages

### Tool calls fail from Python

1. Verify tool name matches exactly (check `pi.getAllTools()`)
2. Check parameter types match schema
3. Look for RPC protocol errors in output

### Timeout issues

For long-running operations:
- Break into smaller chunks
- Use progress updates: `print(f"Processed {i}/{total}")`
- Consider if PTC is the right approach (very long operations might be better as separate tool calls)

## FAQ

**Q: Can I use external Python packages?**
A: Not by default. The execution environment only includes Python standard library. Future versions may support pip install.

**Q: Can I call pi-coding-agent tools from nested functions?**
A: Yes! All tool wrapper functions are async and can be called from any async context in your code.

**Q: What happens if my code has a syntax error?**
A: Python will raise a SyntaxError which will be returned to Claude with the full traceback for debugging.

**Q: Can I use threading or multiprocessing?**
A: Yes, but keep in mind the 4.5 minute timeout applies to the entire execution.

**Q: How do I debug my Python code?**
A: Use `print()` statements — they'll be captured and included in the output.

**Q: What's the overhead of PTC vs direct tool calls?**
A: Slight overhead for a single tool call, but massive savings for 3+ sequential calls.

**Q: Why can't I use tools from other pi extensions?**
A: The pi extensions API does not currently support extensions exposing tools to each other. If you need a tool available in PTC, add it as a custom tool in the `tools/` directory.

## License

MIT

## Contributing

Contributions welcome! Please open an issue to discuss major changes before submitting a PR.
