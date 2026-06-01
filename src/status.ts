import { execFileSync } from "node:child_process";
import { AgentNotFoundError } from "./errors.js";

// === Status 枚举 ===

export enum Status {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  DONE = "DONE",
  CRASHED = "CRASHED",
  CONFLICTED = "CONFLICTED",
  STALE = "STALE",
  REVIEW = "REVIEW",
  ACCEPTED = "ACCEPTED",
  REJECTED = "REJECTED",
}

const TERMINAL_STATUSES: ReadonlySet<Status> = new Set([
  Status.CRASHED,
  Status.CONFLICTED,
  Status.REVIEW,
  Status.ACCEPTED,
  Status.REJECTED,
  Status.STALE,
]);

export interface IAgentData {
  name: string;
  status: string;
  worktree: string;
  prompt: string | null;
  started_at: number | null;
  pid: number | null;
  exit_code: number | null;
  risk_assessment: string | null;
  pr_url: string | null;
  archived: number;
  depends_on: string | null;
  plan: string | null;
}

export interface IStateStore {
  getAgent(name: string): IAgentData | null;
  getAllAgents(): IAgentData[];
  updateAgentStatus(name: string, status: string): void;
}

export interface IProcessManager {
  isAlive(name: string): boolean;
  getPid(name: string): number | null;
  getRecentOutput(name: string): string;
  hasExited(name: string): boolean;
  getExitCode(name: string): number | null;
}

// === StatusDetector ===

export class StatusDetector {
  private readonly state: IStateStore;
  private readonly process: IProcessManager;
  private readonly timeoutMinutes: number;
  private transitionCallback: ((name: string, status: Status) => void) | null =
    null;

  constructor(
    state: IStateStore,
    process: IProcessManager,
    timeoutMinutes: number,
  ) {
    this.state = state;
    this.process = process;
    this.timeoutMinutes = timeoutMinutes;
  }

  setTransitionCallback(cb: (name: string, status: Status) => void): void {
    this.transitionCallback = cb;
  }

  getStatus(name: string): Status {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);

    // 终态不再变
    if (TERMINAL_STATUSES.has(agent.status as Status)) {
      return agent.status as Status;
    }

    if (agent.status === Status.PENDING) return Status.PENDING;
    if (agent.status === Status.DONE) return Status.DONE;

    // RUNNING → ?
    if (agent.status === Status.RUNNING) {
      return this._detectRunningStatus(name, agent);
    }

    return agent.status as Status;
  }

  getRecentOutput(name: string): string {
    return this.process.getRecentOutput(name);
  }

  getDiff(name: string, mode: "stat" | "full" = "stat"): string {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);
    if (!agent.worktree) return "";
    const args = mode === "stat"
      ? ["diff", "--stat", "HEAD"]
      : ["diff", "HEAD"];
    try {
      return execFileSync("git", args, {
        cwd: agent.worktree,
        encoding: "utf-8",
      });
    } catch {
      return "";
    }
  }

  private _detectRunningStatus(name: string, agent: IAgentData): Status {
    // Step 2: STALE 超时检测（仅当进程不再存活时才标记 STALE）
    const startedAt = agent.started_at ?? 0;
    if (startedAt > 0) {
      const elapsed = Date.now() / 1000 - startedAt;
      if (elapsed > this.timeoutMinutes * 60 && !this.process.isAlive(name)) {
        return this._updateAndFire(name, Status.STALE);
      }
    }

    // Step 3: 同实例 isAlive
    if (this.process.isAlive(name)) {
      return Status.RUNNING;
    }

    // Step 4: exit_code 持久化值（最权威）
    const exitCode = agent.exit_code;
    if (exitCode !== null) {
      return exitCode === 0
        ? this._updateAndFire(name, Status.DONE)
        : this._updateAndFire(name, Status.CRASHED);
    }

    // Step 5: 跨实例 PID 复用检测
    const pid = agent.pid;
    if (pid && pid > 0) {
      try {
        process.kill(pid, 0);
        return Status.RUNNING;
      } catch {
        // PID 不存在，进程已退出
      }
    }

    // Step 6: 内存 spawn exit 事件
    if (this.process.hasExited(name)) {
      const code = this.process.getExitCode(name);
      return code === 0
        ? this._updateAndFire(name, Status.DONE)
        : this._updateAndFire(name, Status.CRASHED);
    }

    // Step 7: 日志有内容 + 进程已退出
    const output = this.process.getRecentOutput(name);
    if (output.trim().length > 0 && !this.process.isAlive(name)) {
      return this._updateAndFire(name, Status.DONE);
    }

    // Step 8: worktree 未提交变更 → auto-commit + DONE（仅 exit_code=0）
    if (agent.worktree && !this.process.isAlive(name)) {
      const exitCode = agent.exit_code ?? this.process.getExitCode(name);
      if (exitCode !== null && exitCode !== 0) {
        return this._updateAndFire(name, Status.CRASHED);
      }
      try {
        if (this.hasUncommittedChanges(agent.worktree)) {
          this.autoCommit(name, agent.worktree);
        }
        return this._updateAndFire(name, Status.DONE);
      } catch {
        // auto-commit 失败仍返回 DONE
        return this._updateAndFire(name, Status.DONE);
      }
    }

    // Step 9: 进程不存活且无任何退出信号 → CRASHED
    if (!this.process.isAlive(name) && !this.process.hasExited(name)) {
      return this._updateAndFire(name, Status.CRASHED);
    }

    return Status.RUNNING;
  }

  private _updateAndFire(name: string, status: Status): Status {
    this.state.updateAgentStatus(name, status);
    if (!this.transitionCallback) return status;
    try {
      this.transitionCallback(name, status);
    } catch (err) {
      console.warn(
        `[StatusDetector] transition callback threw for ${name}->${status}: ${err}`,
      );
    }
    return status;
  }

  // === 自动提交辅助 ===
  hasUncommittedChanges(worktreePath: string): boolean {
    const result = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return result.trim().length > 0;
  }

  autoCommit(name: string, worktreePath: string): void {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    try {
      execFileSync("git", ["add", "-A"], { cwd: worktreePath });
      // 检查是否有 staged changes
      try {
        execFileSync("git", ["diff", "--cached", "--quiet"], {
          cwd: worktreePath,
        });
        // 无 staged changes
        return;
      } catch {
        // 有 staged changes
      }
      execFileSync("git", ["commit", "-m", `feat: ${safeName} auto-commit`], {
        cwd: worktreePath,
      });
    } catch (err) {
      console.warn(`[StatusDetector] auto-commit failed for ${name}: ${err}`);
    }
  }
}
