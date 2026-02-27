import { spawn, exec } from "child_process";
import { promisify } from "util";
import type { SandboxManager } from "./types";

const execAsync = promisify(exec);

const EXECUTION_TIMEOUT = 270_000; // 4.5 minutes in milliseconds

/**
 * Subprocess-based sandbox implementation
 * Executes Python code in a local subprocess with timeout and cancellation support
 */
class SubprocessSandbox implements SandboxManager {
  async execute(code: string, cwd: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      // Spawn Python process with unbuffered output
      const proc = spawn("python3", ["-u", "-c", code], {
        cwd,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!killed) {
          killed = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (proc.exitCode === null) {
              proc.kill("SIGKILL");
            }
          }, 5000);
          reject(new Error(`Execution timed out after ${EXECUTION_TIMEOUT / 1000} seconds`));
        }
      }, EXECUTION_TIMEOUT);

      // Handle abort signal
      const abortHandler = () => {
        if (!killed) {
          killed = true;
          clearTimeout(timeoutId);
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (proc.exitCode === null) {
              proc.kill("SIGKILL");
            }
          }, 5000);
          reject(new Error("Execution aborted"));
        }
      };

      if (signal) {
        if (signal.aborted) {
          proc.kill("SIGTERM");
          reject(new Error("Execution aborted"));
          return;
        }
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Capture stdout and stderr
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Handle process exit
      proc.on("exit", (code, signal_name) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }

        if (killed) {
          return; // Already handled in timeout/abort
        }

        if (code === 0) {
          resolve(stdout);
        } else {
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          reject(new Error(errorMsg));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        if (!killed) {
          reject(new Error(`Failed to spawn Python process: ${err.message}`));
        }
      });
    });
  }

  async cleanup(): Promise<void> {
    // No persistent resources to clean up
  }
}

/**
 * Docker-based sandbox implementation
 * Executes Python code in an isolated Docker container
 */
class DockerSandbox implements SandboxManager {
  private containerId: string | null = null;
  private lastUsed: number = 0;
  private readonly sessionId: string;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startCleanupTimer();
  }

  private startCleanupTimer() {
    // Check every 60 seconds for expired containers
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60_000);
  }

  private async cleanupExpired() {
    if (this.containerId && Date.now() - this.lastUsed > EXECUTION_TIMEOUT) {
      await this.stopContainer();
    }
  }

  private async getOrCreateContainer(cwd: string): Promise<string> {
    // Reuse existing container if still valid
    if (this.containerId && Date.now() - this.lastUsed < EXECUTION_TIMEOUT) {
      this.lastUsed = Date.now();
      return this.containerId;
    }

    // Clean up old container if exists
    if (this.containerId) {
      await this.stopContainer();
    }

    // Create new container
    const containerName = `pi-ptc-${this.sessionId}-${Date.now()}`;

    try {
      const { stdout } = await execAsync(
        `docker run -d --rm --network none --name ${containerName} ` +
        `-v "${cwd}:/workspace:ro" ` +
        `--memory 512m --cpus 1.0 ` +
        `python:3.12-slim tail -f /dev/null`
      );

      this.containerId = stdout.trim();
      this.lastUsed = Date.now();
      return this.containerId;
    } catch (error) {
      throw new Error(
        `Failed to create Docker container: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async stopContainer() {
    if (!this.containerId) return;

    try {
      await execAsync(`docker stop ${this.containerId}`);
    } catch (error) {
      // Container might already be stopped
      console.error(`Failed to stop container ${this.containerId}:`, error);
    }

    this.containerId = null;
  }

  async execute(code: string, cwd: string, signal?: AbortSignal): Promise<string> {
    const containerId = await this.getOrCreateContainer(cwd);

    return new Promise((resolve, reject) => {
      // Execute Python code in container
      const proc = spawn("docker", ["exec", "-i", containerId, "python3", "-u", "-c", code], {
        cwd,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!killed) {
          killed = true;
          proc.kill("SIGTERM");
          reject(new Error(`Execution timed out after ${EXECUTION_TIMEOUT / 1000} seconds`));
        }
      }, EXECUTION_TIMEOUT);

      // Handle abort signal
      const abortHandler = () => {
        if (!killed) {
          killed = true;
          clearTimeout(timeoutId);
          proc.kill("SIGTERM");
          reject(new Error("Execution aborted"));
        }
      };

      if (signal) {
        if (signal.aborted) {
          proc.kill("SIGTERM");
          reject(new Error("Execution aborted"));
          return;
        }
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Capture stdout and stderr
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Handle process exit
      proc.on("exit", (code) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }

        if (killed) {
          return; // Already handled in timeout/abort
        }

        if (code === 0) {
          resolve(stdout);
        } else {
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          reject(new Error(errorMsg));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        if (!killed) {
          reject(new Error(`Failed to execute in Docker: ${err.message}`));
        }
      });
    });
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.stopContainer();
  }
}

/**
 * Check if Docker is available on the system
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execAsync("docker --version");
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a sandbox manager (tries Docker first, falls back to subprocess)
 */
export async function createSandbox(): Promise<SandboxManager> {
  const dockerAvailable = await isDockerAvailable();
  const sessionId = Math.random().toString(36).substring(7);

  if (dockerAvailable) {
    console.log("[PTC] Using Docker sandbox");
    return new DockerSandbox(sessionId);
  } else {
    console.log("[PTC] Docker not available, using subprocess sandbox");
    return new SubprocessSandbox();
  }
}
