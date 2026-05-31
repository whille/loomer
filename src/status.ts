import { execSync } from "node:child_process";
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
  Status.STALE,
  Status.REVIEW,
  Status.ACCEPTED,
  Status.REJECTED,
]);

function isTerminal(status: Status): boolean {
  return TERMINAL_STATUSES.has(status);
}

// === 依赖接口 ===

export interface IAgentData {
  name: string;
  status: string;
  pid: number | null;
  started_at: number;
  exit_code: number | null;
  worktree: string | null;
}

export interface IStateStore {
  getAgent(name: string): IAgentData | null;
  updateAgentStatus(name: string, status: Status): void;
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

    const currentStatus = agent.status as Status;

    // Step 1: 终态直返
    if (isTerminal(currentStatus)) return currentStatus;
    // DONE/PENDING 不做检测（设计不变量 Step 1）
    if (currentStatus === Status.DONE) return Status.DONE;
    if (currentStatus === Status.PENDING) return Status.PENDING;

    return this._detectRunningStatus(name, agent);
  }

  getRecentOutput(name: string): string {
    return this.process.getRecentOutput(name);
  }

  getDiff(name: string, mode: "stat" | "full" = "stat"): string {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);
    if (!agent.worktree) return "";

    try {
      const cmd = mode === "stat" ? "git diff --stat HEAD" : "git diff HEAD";
      return execSync(cmd, { cwd: agent.worktree, encoding: "utf-8" });
    } catch {
      return "";
    }
  }

  // --- 私有方法 ---

  private _detectRunningStatus(name: string, agent: IAgentData): Status {
    // Step 2: STALE 超时检测
    const startedAt = agent.started_at ?? 0;
    if (startedAt > 0) {
      const elapsed = Date.now() / 1000 - startedAt;
      if (elapsed > this.timeoutMinutes * 60) {
        return this._updateAndFire(name, Status.STALE);
      }
    }

    // Step 3: 同实例 isAlive
    if (this.process.isAlive(name)) {
      return Status.RUNNING;
    }

    // Step 4: 跨实例 PID 检测
    const pid = agent.pid ?? this.process.getPid(name);
    if (pid !== null && this._isPidAlive(pid)) {
      return Status.RUNNING;
    }

    // Step 5: exit_code 持久化值（最权威）
    const exitCode = agent.exit_code;
    if (exitCode !== null) {
      return exitCode === 0
        ? this._updateAndFire(name, Status.DONE)
        : this._updateAndFire(name, Status.CRASHED); // short-circuit
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

    // Step 8: worktree 有未提交变更
    if (agent.worktree && this._hasUncommittedChanges(agent.worktree)) {
      this._autoCommit(agent.worktree, name);
      return this._updateAndFire(name, Status.DONE);
    }

    // Step 9: 兜底 CRASHED
    return this._updateAndFire(name, Status.CRASHED);
  }

  private _updateAndFire(name: string, newStatus: Status): Status {
    this.state.updateAgentStatus(name, newStatus);
    this._fireTransition(name, newStatus);
    return newStatus;
  }

  private _fireTransition(name: string, status: Status): void {
    if (!this.transitionCallback) return;
    try {
      this.transitionCallback(name, status);
    } catch (err) {
      console.warn(
        `[StatusDetector] transition callback threw for ${name}->${status}: ${err}`,
      );
    }
  }

  private _isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private _hasUncommittedChanges(worktreePath: string): boolean {
    try {
      const result = execSync("git status --porcelain", {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  private _autoCommit(worktreePath: string, name: string): void {
    try {
      execSync("git add -A", { cwd: worktreePath });
      try {
        execSync("git diff --cached --quiet", { cwd: worktreePath });
        return; // 无变更
      } catch {
        // diff --cached --quiet exit ≠0 表示有变更，继续 commit
      }
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      execSync(`git commit -m "feat: ${safeName} auto-commit"`, {
        cwd: worktreePath,
      });
    } catch (err) {
      console.warn(`[StatusDetector] auto-commit failed for ${name}: ${err}`);
    }
  }
}
