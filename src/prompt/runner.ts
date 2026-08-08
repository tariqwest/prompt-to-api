import { spawn } from "node:child_process";
import type { PlannedInvocation } from "../types.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunOptions {
  plan: PlannedInvocation;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export async function runPlanned(opts: RunOptions): Promise<RunResult> {
  const { plan, timeoutMs, signal, onStdout, onStderr } = opts;
  const [bin, ...args] = plan.argv;
  if (!bin) throw new Error("empty argv");

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      finish({
        stdout,
        stderr: stderr + `\n[prompt-to-api] timed out after ${timeoutMs}ms`,
        exitCode: null,
        signal: "SIGTERM",
      });
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      finish({ stdout, stderr, exitCode: code, signal: sig });
    });

    if (plan.stdin != null) {
      child.stdin?.end(plan.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Simple async semaphore for global + per-tool concurrency. */
export class ConcurrencyGate {
  private globalActive = 0;
  private perTool = new Map<string, number>();
  private waiters: Array<() => void> = [];

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerAgent: number,
  ) {}

  async acquire(toolId: string): Promise<() => void> {
    for (;;) {
      const toolN = this.perTool.get(toolId) ?? 0;
      if (this.globalActive < this.maxGlobal && toolN < this.maxPerAgent) {
        this.globalActive += 1;
        this.perTool.set(toolId, toolN + 1);
        return () => {
          this.globalActive = Math.max(0, this.globalActive - 1);
          const n = (this.perTool.get(toolId) ?? 1) - 1;
          if (n <= 0) this.perTool.delete(toolId);
          else this.perTool.set(toolId, n);
          const next = this.waiters.shift();
          next?.();
        };
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}
