import { type ChildProcess, spawn } from "node:child_process";
import { AgentNotFoundError, LoomerError } from "./errors.js";
import type { IProcessManager } from "./status.js";
import type { LoomerConfig } from "./types/web.js";

// === 公共接口 ===

export interface ProcessInfo {
  name: string;
  pid: number | null;
  alive: boolean;
}

// === 内部追踪 ===

interface ProcessEntry {
  child: ChildProcess;
  outputLines: string[];
  partialLine: string;
  exited: boolean;
  exitCode: number | null;
}

// === Dogfooding 教训 8.1：硬编码不可省略 ===

const HARDCODED_FLAGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
] as const;

// === ProcessManager ===

export class ProcessManager implements IProcessManager {
  private readonly config: LoomerConfig;
  private readonly processes: Map<string, ProcessEntry> = new Map();

  constructor(config: LoomerConfig) {
    this.config = config;
  }

  start(name: string, worktreePath: string, prompt: string): void {
    const existing = this.processes.get(name);
    if (existing && !existing.exited) {
      throw new LoomerError(`Agent '${name}' is already running`);
    }

    const args = ["-p", prompt, ...HARDCODED_FLAGS, ...this.config.claudeArgs];
    const child = spawn(this.config.claudePath, args, {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entry: ProcessEntry = {
      child,
      outputLines: [],
      partialLine: "",
      exited: false,
      exitCode: null,
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = entry.partialLine + chunk.toString();
      const lines = text.split("\n");
      // 最后一段可能不完整，保留缓冲
      const last = lines.pop();
      entry.partialLine = last ?? "";
      for (const line of lines) {
        if (line.trim()) {
          entry.outputLines.push(line);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      console.warn(`[ProcessManager] stderr: ${chunk.toString().trim()}`);
    });

    child.on("exit", (code: number | null) => {
      // 刷入剩余缓冲
      if (entry.partialLine.trim()) {
        entry.outputLines.push(entry.partialLine);
        entry.partialLine = "";
      }
      entry.exited = true;
      entry.exitCode = code;
    });

    child.stdin.write(prompt);
    child.stdin.end();

    this.processes.set(name, entry);
  }

  stop(name: string): void {
    const entry = this.processes.get(name);
    if (!entry) throw new AgentNotFoundError(`Agent not found: ${name}`);
    if (entry.exited) return;
    entry.child.kill("SIGTERM");
  }

  isAlive(name: string): boolean {
    const entry = this.processes.get(name);
    return entry !== undefined && !entry.exited;
  }

  hasExited(name: string): boolean {
    return this.processes.get(name)?.exited ?? false;
  }

  getExitCode(name: string): number | null {
    const entry = this.processes.get(name);
    if (!entry || !entry.exited) return null;
    return entry.exitCode;
  }

  getPid(name: string): number | null {
    const entry = this.processes.get(name);
    return entry?.child.pid ?? null;
  }

  getRecentOutput(name: string, lines = 50): string {
    const entry = this.processes.get(name);
    if (!entry) throw new AgentNotFoundError(`Agent not found: ${name}`);
    const parsed = ProcessManager._parseStreamJson(entry.outputLines);
    const allLines = parsed.split("\n");
    return allLines.slice(-lines).join("\n");
  }

  listProcesses(): ProcessInfo[] {
    return Array.from(this.processes.entries()).map(([name, entry]) => ({
      name,
      pid: entry.child.pid ?? null,
      alive: !entry.exited,
    }));
  }

  _getWorkerLog(name: string): string {
    const entry = this.processes.get(name);
    if (!entry) throw new AgentNotFoundError(`Agent not found: ${name}`);
    return entry.outputLines.join("\n");
  }

  static _parseStreamJson(lines: string[]): string {
    const textParts: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta") {
            textParts.push(event.delta.text || "");
          }
        } else if (event.type === "result") {
          for (const block of event.result || []) {
            if (block.type === "text") textParts.push(block.text || "");
          }
        }
      } catch {
        /* skip non-JSON lines */
      }
    }
    return textParts.length > 0 ? textParts.join("") : lines.join("\n");
  }
}
