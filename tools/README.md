# Custom Tools

Drop `.js` files in this directory to register custom tools with PTC.

Each file should export a default object with the following fields:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Tool name (used as the Python function name) |
| `label` | no | Display label |
| `description` | yes | Description shown to the model |
| `parameters` | yes | JSON Schema object describing the tool's parameters |
| `execute` | yes | `async (toolCallId, params, signal) => result` |

## Example

See `get_weather.js.example` for a complete example. To try it:

```bash
cp get_weather.js.example get_weather.js
```

Then restart pi — the tool will be auto-discovered and available both directly and via `code_execution`.

## Notes

- Only `.js` files are loaded (not `.ts`, `.example`, etc.)
- Files are loaded at extension startup
- The `execute` function receives `(toolCallId, params, signal)` and must return `{ content: [{ type: "text", text: "..." }] }`
