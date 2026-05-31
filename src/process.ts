import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { LoomerConfig } from "./config.js";
import type { StateStore } from "./state.js";

// 常见 CLI 工具路径（bun、nvm 等），确保子进程可找到
const EXTRA_PATHS = [
  path.join(os.homedir(), ".bun", "bin"),
  path.join(os.homedir(), ".local", "bin"),
  "/usr/local/bin",
];

export interface ProcessInfo {
  name: string;
  pid: number | null;
  alive: boolean;
}

interface TrackedChild {
  child: ChildProcess;
  exitCode: number | null;
  exited: boolean;
  outputLines: string[];
}

const activeManagers = new Set<ProcessManager>();
let signalHandlersRegistered = false;

function registerSignalHandlers(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(sig, () => {
      for (const mgr of activeManagers) {
        mgr.killAllProcessGroups(sig);
      }
      process.exit(128 + (sig === "SIGTERM" ? 15 : sig === "SIGINT" ? 2 : 1));
    });
  }
}

export class ProcessManager {
  private readonly config: LoomerConfig;
  private readonly state: StateStore;
  private readonly processes: Map<string, TrackedChild> = new Map();

  constructor(config: LoomerConfig, state: StateStore) {
    this.config = config;
    this.state = state;
    activeManagers.add(this);
    registerSignalHandlers();
  }

  // 信号处理器调用：杀所有被跟踪的进程组
  killAllProcessGroups(sig: string): void {
    for (const [, tracked] of this.processes) {
      if (!tracked.exited && tracked.child.pid) {
        try {
          process.kill(-tracked.child.pid, sig as NodeJS.Signals);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") {
            console.warn(
              `[ProcessManager] signal handler kill(-${tracked.child.pid}) failed: ${code ?? err}`,
            );
          }
        }
      }
    }
  }

  start(name: string, worktreePath: string, prompt: string): void {
    const cmd = this.config.claudePath;
    // 非交互模式必须的参数（Dogfooding 教训 8.1 + 8.23）
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--disallowed-tools",
      "AskUserQuestion",
      ...this.config.claudeArgs,
    ];

    const env = { ...process.env };

    // 限制 agent 子进程的 worker 并发数，防止 vitest/esbuild 等吃满资源
    const workerLimit = Math.max(2, Math.floor((os.cpus().length || 4) / (this.config.maxConcurrent || 3)));
    env.VITEST_POOL_MAX_WORKERS = String(workerLimit);
    env.VITEST_MAX_THREADS = String(workerLimit);
    env.ESBUILD_THREADS = String(Math.min(workerLimit, 4));
    env.UV_THREADPOOL_SIZE = String(Math.min(workerLimit * 2, 16));
    const existingPath = env.PATH ?? "";
    const pathSet = new Set(existingPath.split(path.delimiter));
    const extraDirs = EXTRA_PATHS.filter((d) => !pathSet.has(d));
    if (extraDirs.length > 0) {
      env.PATH = `${extraDirs.join(path.delimiter)}${path.delimiter}${existingPath}`;
    }

    const child = spawn(cmd, args, {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: true,
    });
    child.unref();

    // stdin pipe 传 prompt
    child.stdin.write(prompt);
    child.stdin.end();

    const tracked: TrackedChild = {
      child,
      exitCode: null,
      exited: false,
      outputLines: [],
    };

    // stdout pipe 实时解析
    child.stdout.on("data", (chunk: Buffer) => {
      tracked.outputLines.push(chunk.toString());
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // log warning for stderr
      console.warn(
        `[ProcessManager:${name}] stderr: ${chunk.toString().trim()}`,
      );
    });

    // exit 回调写 exit_code
    child.on("exit", (code: number | null) => {
      tracked.exitCode = code;
      tracked.exited = true;
      this.state.updateAgent(name, { exit_code: code, pid: null });
    });

    this.processes.set(name, tracked);
  }

  stop(name: string): void {
    const tracked = this.processes.get(name);
    if (tracked && !tracked.exited) {
      const pid = tracked.child.pid;
      // 杀整个进程组（负 PID），避免孙子进程变孤儿
      try {
        if (pid) process.kill(-pid, "SIGTERM");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          // 进程组已退出，降级杀主进程
          tracked.child.kill("SIGTERM");
        } else {
          // EPERM 或意外错误，记录日志仍尝试降级
          console.warn(
            `[ProcessManager] process.kill(-${pid}) failed: ${code ?? err}`,
          );
          tracked.child.kill("SIGTERM");
        }
      }
    }
  }

  list(): string[] {
    return [...this.processes.keys()];
  }

  dispose(): void {
    activeManagers.delete(this);
  }

  isAlive(name: string): boolean {
    const tracked = this.processes.get(name);
    return tracked !== undefined && !tracked.exited;
  }

  getPid(name: string): number | null {
    const tracked = this.processes.get(name);
    if (!tracked) return null;
    return tracked.child.pid ?? null;
  }

  getRecentOutput(name: string): string {
    const tracked = this.processes.get(name);
    if (!tracked) return "";
    const allOutput = tracked.outputLines.join("");
    const parsed = ProcessManager.parseStreamJson(allOutput.split("\n"));
    const result = parsed || allOutput;
    const MAX_CHARS = 50000;
    if (result.length > MAX_CHARS) {
      return "...(truncated)\n" + result.slice(-MAX_CHARS);
    }
    return result;
  }

  hasExited(name: string): boolean {
    const tracked = this.processes.get(name);
    return tracked?.exited ?? false;
  }

  getExitCode(name: string): number | null {
    const tracked = this.processes.get(name);
    return tracked?.exitCode ?? null;
  }

  listProcesses(): ProcessInfo[] {
    return Array.from(this.processes.entries()).map(([name, tracked]) => ({
      name,
      pid: tracked.child.pid ?? null,
      alive: !tracked.exited,
    }));
  }

  static parseStreamJson(lines: string[]): string {
    const textParts: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta") {
            textParts.push((delta.text as string) || "");
          }
          // 跳过 tool_use/input_json_delta 等
        } else if (event.type === "result") {
          const result = event.result as
            | Array<Record<string, unknown>>
            | undefined;
          for (const block of result ?? []) {
            if (block.type === "text")
              textParts.push((block.text as string) || "");
            // 跳过 tool_use / tool_result 块
          }
        }
        // 跳过 message_start, message_delta, content_block_start, content_block_stop 等控制事件
      } catch {
        // 非 JSON 行
      }
    }
    return textParts.length > 0 ? textParts.join("") : lines.join("\n");
  }
}
