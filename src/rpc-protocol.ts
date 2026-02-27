import { ChildProcess } from "child_process";
import readline from "readline";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import type { RpcMessage, ToolInfo } from "./types";

type ExecuteTool = (toolName: string, params: any) => Promise<any>;

/**
 * RPC protocol handler for communicating with Python runtime
 */
export class RpcProtocol {
  private lineReader: readline.Interface;
  private completionPromise: Promise<string>;
  private completionResolve!: (value: string) => void;
  private completionReject!: (error: Error) => void;
  private stderr = "";
  private stdout = ""; // Capture non-JSON stdout (print statements)
  private currentLine = 0;
  private userCodeLines: string[] = [];

  constructor(
    private proc: ChildProcess,
    private tools: Map<string, ToolInfo>,
    private executeTool: ExecuteTool,
    private userCode: string,
    private signal?: AbortSignal,
    private onUpdate?: AgentToolUpdateCallback<any>
  ) {
    // Store user code lines for display
    this.userCodeLines = userCode.split("\n");
    // Set up line reader for stdout
    this.lineReader = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    // Create completion promise
    this.completionPromise = new Promise((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });

    // Handle stdout lines (RPC messages)
    this.lineReader.on("line", (line) => {
      this.handleMessage(line);
    });

    // Capture stderr
    proc.stderr?.on("data", (data) => {
      this.stderr += data.toString();
    });

    // Handle process exit
    proc.on("exit", (code, signal_name) => {
      if (code !== 0 && code !== null) {
        const errorMsg = this.stderr || `Process exited with code ${code}`;
        this.completionReject(new Error(errorMsg));
      }
    });

    // Handle process errors
    proc.on("error", (err) => {
      this.completionReject(new Error(`Process error: ${err.message}`));
    });

    // Handle abort signal
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (proc.exitCode === null) {
              proc.kill("SIGKILL");
            }
          }, 5000);
          this.completionReject(new Error("Execution aborted"));
        },
        { once: true }
      );
    }
  }

  private async handleMessage(line: string): Promise<void> {
    // Try to parse as JSON RPC message
    try {
      const msg = JSON.parse(line) as RpcMessage;

      switch (msg.type) {
        case "tool_call":
          await this.handleToolCall(msg);
          break;

        case "execution_progress":
          this.currentLine = msg.line;
          if (this.onUpdate) {
            this.onUpdate({
              content: [
                {
                  type: "text",
                  text: `Executing line ${msg.line}/${this.userCodeLines.length}`,
                },
              ],
              details: {
                currentLine: msg.line,
                totalLines: this.userCodeLines.length,
                userCode: this.userCodeLines,
              },
            });
          }
          break;

        case "complete":
          // Prepend any captured print statements to the output
          const finalOutput = this.stdout ? this.stdout + "\n" + msg.output : msg.output;
          this.completionResolve(finalOutput);
          break;

        case "error":
          const errorMsg = msg.message + (msg.traceback ? "\n" + msg.traceback : "");
          this.completionReject(new Error(errorMsg));
          break;

        case "update":
          if (this.onUpdate) {
            // Call onUpdate with a partial result
            this.onUpdate({
              content: [{ type: "text", text: msg.message }],
              details: undefined,
            });
          }
          break;
      }
    } catch (err) {
      // Not a JSON message - likely a print statement
      // Collect it as stdout
      if (this.stdout) {
        this.stdout += "\n" + line;
      } else {
        this.stdout = line;
      }
    }
  }

  private async handleToolCall(msg: {
    id: string;
    tool: string;
    params: any;
  }): Promise<void> {
    try {
      const toolInfo = this.tools.get(msg.tool);
      if (!toolInfo) {
        throw new Error(`Unknown tool: ${msg.tool}`);
      }

      // Execute the actual tool
      const result = await this.executeTool(msg.tool, msg.params);

      // Send result back to Python
      this.send({
        type: "tool_result",
        id: msg.id,
        content: result.content || [],
      });
    } catch (err) {
      // Send error back to Python
      this.send({
        type: "tool_result",
        id: msg.id,
        content: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private send(msg: RpcMessage): void {
    if (this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  async waitForCompletion(): Promise<string> {
    return this.completionPromise;
  }
}
