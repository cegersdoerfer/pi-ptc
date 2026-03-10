// Native implementations of built-in agent tools for the subprocess.
// These run directly in Node.js without RPC, since the agent framework
// does not expose execute functions for built-in tools to extensions.

const _fs = require("fs");
const _path = require("path");
const _child_process = require("child_process");

const _BUILTIN_CWD = process.cwd();

/** Read a file and return contents with line numbers */
async function read(params: { path: string; offset?: number; limit?: number }): Promise<string> {
  const filePath = _path.resolve(_BUILTIN_CWD, params.path);
  const content = _fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const offset = params.offset ?? 0;
  const limit = params.limit ?? lines.length;
  const selected = lines.slice(offset, offset + limit);

  // Format with line numbers (1-based, matching cat -n style)
  return selected
    .map((line: string, i: number) => `${String(offset + i + 1).padStart(6, " ")}\t${line}`)
    .join("\n");
}

/** Write content to a file */
async function write(params: { path: string; content: string }): Promise<string> {
  const filePath = _path.resolve(_BUILTIN_CWD, params.path);
  const dir = _path.dirname(filePath);
  if (!_fs.existsSync(dir)) {
    _fs.mkdirSync(dir, { recursive: true });
  }
  _fs.writeFileSync(filePath, params.content);
  return `Successfully wrote to ${filePath}`;
}

/** Edit a file by replacing old text with new text */
async function edit(params: { path: string; oldText: string; newText: string }): Promise<string> {
  const filePath = _path.resolve(_BUILTIN_CWD, params.path);
  const content = _fs.readFileSync(filePath, "utf-8");
  const idx = content.indexOf(params.oldText);
  if (idx === -1) {
    throw new Error(`oldText not found in ${filePath}`);
  }
  // Check for uniqueness
  const secondIdx = content.indexOf(params.oldText, idx + 1);
  if (secondIdx !== -1) {
    throw new Error(`oldText is not unique in ${filePath} — provide more context`);
  }
  const newContent = content.slice(0, idx) + params.newText + content.slice(idx + params.oldText.length);
  _fs.writeFileSync(filePath, newContent);
  return `Successfully edited ${filePath}`;
}

/** Execute a shell command */
async function bash(params: { command: string; timeout?: number }): Promise<string> {
  const timeout = params.timeout ?? 120000;
  try {
    const result = _child_process.execSync(params.command, {
      cwd: _BUILTIN_CWD,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return String(result);
  } catch (err: any) {
    const stdout = err.stdout ? String(err.stdout) : "";
    const stderr = err.stderr ? String(err.stderr) : "";
    const output = (stdout + "\n" + stderr).trim();
    if (err.killed) {
      return `Command timed out after ${timeout}ms\n${output}`;
    }
    return `Exit code ${err.status ?? 1}\n${output}`;
  }
}

/** Search file contents using grep/ripgrep */
async function grep(params: {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}): Promise<string> {
  const searchPath = params.path ? _path.resolve(_BUILTIN_CWD, params.path) : _BUILTIN_CWD;
  const args = ["--color=never", "--line-number"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.context) args.push(`--context=${params.context}`);
  if (params.glob) args.push(`--glob=${params.glob}`);
  if (params.limit) args.push(`--max-count=${params.limit}`);
  args.push("--", params.pattern, searchPath);

  try {
    // Try rg first, fall back to grep
    try {
      return String(_child_process.execSync(`rg ${args.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
        cwd: _BUILTIN_CWD,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
      })).trim();
    } catch (rgErr: any) {
      // rg exit code 1 = no matches
      if (rgErr.status === 1) return "No matches found.";
      // rg not found, try grep -r
      const grepArgs = ["--color=never", "-n", "-r"];
      if (params.ignoreCase) grepArgs.push("-i");
      if (params.literal) grepArgs.push("-F");
      if (params.context) grepArgs.push(`-C${params.context}`);
      if (params.glob) grepArgs.push(`--include=${params.glob}`);
      grepArgs.push("--", params.pattern, searchPath);
      return String(_child_process.execSync(`grep ${grepArgs.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
        cwd: _BUILTIN_CWD,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
      })).trim();
    }
  } catch (err: any) {
    if (err.status === 1) return "No matches found.";
    throw err;
  }
}

/** Find files matching a glob pattern */
async function find(params: { pattern: string; path?: string; limit?: number }): Promise<string> {
  const searchPath = params.path ? _path.resolve(_BUILTIN_CWD, params.path) : _BUILTIN_CWD;
  const limit = params.limit ?? 200;
  try {
    // Try fd first, fall back to find
    try {
      const result = String(_child_process.execSync(
        `fd --glob '${params.pattern.replace(/'/g, "'\\''")}' '${searchPath.replace(/'/g, "'\\''")}'` +
        ` --max-results ${limit}`,
        { cwd: _BUILTIN_CWD, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" }
      )).trim();
      return result || "No files found.";
    } catch {
      const result = String(_child_process.execSync(
        `find '${searchPath.replace(/'/g, "'\\''")}' -name '${params.pattern.replace(/'/g, "'\\''")}' -type f` +
        ` | head -n ${limit}`,
        { cwd: _BUILTIN_CWD, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" }
      )).trim();
      return result || "No files found.";
    }
  } catch (err: any) {
    if (err.stdout) return String(err.stdout).trim() || "No files found.";
    throw err;
  }
}

/** List directory contents */
async function ls(params: { path?: string; limit?: number }): Promise<string> {
  const dirPath = params.path ? _path.resolve(_BUILTIN_CWD, params.path) : _BUILTIN_CWD;
  const entries = _fs.readdirSync(dirPath);
  const limit = params.limit ?? entries.length;
  const selected = entries.slice(0, limit);

  const results: string[] = [];
  for (const entry of selected) {
    const fullPath = _path.join(dirPath, entry);
    try {
      const stat = _fs.statSync(fullPath);
      results.push(stat.isDirectory() ? `${entry}/` : entry);
    } catch {
      results.push(entry);
    }
  }
  return results.join("\n");
}
