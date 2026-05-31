import { type ChildProcess, spawn } from "node:child_process";
import type { LoomerConfig } from "./config.js";
import type { StateStore } from "./state.js";

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
    // 三件套硬编码不可省略（Dogfooding 教训 8.1）
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...this.config.claudeArgs,
    ];

    const child = spawn(cmd, args, {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
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
