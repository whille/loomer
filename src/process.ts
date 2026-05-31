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

export class ProcessManager {
  private readonly config: LoomerConfig;
  private readonly state: StateStore;
  private readonly processes: Map<string, TrackedChild> = new Map();

  constructor(config: LoomerConfig, state: StateStore) {
    this.config = config;
    this.state = state;
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
    });

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
      tracked.child.kill("SIGTERM");
    }
  }

  list(): string[] {
    return [...this.processes.keys()];
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

  getRecentOutput(name: string, lines = 50): string {
    const tracked = this.processes.get(name);
    if (!tracked) return "";
    const allOutput = tracked.outputLines.join("");
    const parsed = ProcessManager.parseStreamJson(allOutput.split("\n"));
    if (parsed) return parsed;
    const allLines = allOutput.split("\n").filter(Boolean);
    return allLines.slice(-lines).join("\n");
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
        } else if (event.type === "result") {
          const result = event.result as
            | Array<Record<string, unknown>>
            | undefined;
          for (const block of result ?? []) {
            if (block.type === "text")
              textParts.push((block.text as string) || "");
          }
        }
      } catch {
        // 非 JSON 行
      }
    }
    return textParts.length > 0 ? textParts.join("") : lines.join("\n");
  }
}
