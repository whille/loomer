import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { LoomerConfig } from "./config.js";
import { AgentNotFoundError, MergeError } from "./errors.js";
import { autoResolveConflictFile } from "./merge.js";
import { DAGValidator, PlanExecutor, PlanParser } from "./plan.js";
import { ProcessManager } from "./process.js";
import { type RiskAssessment, SafetyChecks } from "./safety.js";
import { type AgentData, StateStore } from "./state.js";
import {
  type IProcessManager,
  type IStateStore,
  Status,
  StatusDetector,
} from "./status.js";
import type {
  AgentInfo,
  DagData,
  PlanProgress,
  PlanResult,
} from "./types/web.js";
import { createApp } from "./web.js";
import { WorkspaceManager } from "./workspace.js";

export class LoomerApp {
  private readonly config: LoomerConfig;
  private readonly state: StateStore;
  private readonly processManager: ProcessManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly safety: SafetyChecks;
  private readonly statusDetector: StatusDetector;
  private readonly repoPath: string;
  private planExecutor: PlanExecutor | null = null;
  private server: http.Server | null = null;
  private serverPort: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _mergeLocked = false;
  private _mergeQueue: Array<{ name: string; worktreePath: string }> = [];

  /** 从 config 创建完整 LoomerApp（CLI 入口用） */
  static create(config: LoomerConfig, repoPath?: string): LoomerApp {
    const resolved = repoPath ?? process.cwd();
    const state = new StateStore(config, resolved);
    const processManager = new ProcessManager(config, state);
    const workspaceManager = new WorkspaceManager(config, resolved);
    return new LoomerApp(config, state, processManager, workspaceManager, undefined, resolved);
  }

  constructor(
    config: LoomerConfig,
    state: StateStore & { asIStateStore?: () => IStateStore },
    processManager: ProcessManager,
    workspaceManager: WorkspaceManager,
    iStateStore?: IStateStore,
    repoPath?: string,
  ) {
    this.config = config;
    this.state = state;
    this.processManager = processManager;
    this.workspaceManager = workspaceManager;
    this.repoPath = repoPath ?? process.cwd();
    this.safety = new SafetyChecks(this.repoPath);

    // StatusDetector + transition callback (auto-done)
    const detectorState =
      iStateStore ??
      state.asIStateStore?.() ??
      (state as unknown as IStateStore);
    this.statusDetector = new StatusDetector(
      detectorState,
      processManager as unknown as IProcessManager,
      config.defaultTimeoutMinutes,
    );
    this.statusDetector.setTransitionCallback((name, status) => {
      this.onTransition(name, status);
    });
  }

  // === Transition callback ===

  onTransition(name: string, status: Status): void {
    if (status === Status.DONE) {
      this.done(name);
      return;
    }
    if (this.planExecutor) {
      switch (status) {
        case Status.CRASHED: this.planExecutor.onTaskCrashed(name); break;
        case Status.CONFLICTED: this.planExecutor.onTaskConflicted(name); break;
        case Status.STALE: this.planExecutor.onTaskStale(name); break;
        case Status.REVIEW: this.planExecutor.onTaskReview(name); break;
      }
    }
  }

  // === Agent 生命周期 ===

  start(name: string, prompt: string): void {
    SafetyChecks.validateName(name);

    // 创建 worktree
    const ws = this.workspaceManager.create(
      name,
      this.config.baseBranch || undefined,
    );

    // 依赖任务完成后主分支有新代码，rebase worktree 以获取最新
    const baseBranch = this.config.baseBranch || "master";
    try {
      execFileSync("git", ["rebase", baseBranch], {
        cwd: ws.path,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      try {
        execFileSync("git", ["rebase", "--abort"], {
          cwd: ws.path,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // 忽略
      }
    }

    // 启动 agent 进程
    this.processManager.start(name, ws.path, prompt);

    // 更新状态
    const pid = this.processManager.getPid(name);
    this.state.updateAgent(name, {
      status: "RUNNING",
      pid,
      started_at: Date.now() / 1000,
      worktree: ws.path,
      prompt,
      branch: name,
    });
  }

  done(name: string): void {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);
    if (!agent.worktree)
      throw new AgentNotFoundError(`Agent ${name} has no worktree`);

    // 1. assessRisk — 必须 merge 前
    const assessment = this.safety.assessRisk(
      name,
      agent.worktree,
      this.config.mergeStrategy,
      this.config.autoMergeRules,
      this.config.baseBranch || undefined,
    );

    // 2. 持久化风险结果
    this.state.updateAgent(name, { risk_assessment: assessment.toDict() });

    // 3. merge agent 分支
    try {
      this._mergeAgent(name, agent.worktree);
    } catch (err) {
      if (err instanceof MergeError) {
        this.state.updateAgentStatus(name, "CONFLICTED");
        return;
      }
      throw err;
    }

    // 4. 停止 agent 进程
    this.processManager.stop(name);

    // 5. 分级决策
    const strategy = this.config.mergeStrategy;

    if (strategy === "never") {
      this.state.updateAgentStatus(name, "ACCEPTED");
      this.workspaceManager.remove(name);
      this.state.archiveAgent(name);
    } else if (strategy === "always") {
      this.state.updateAgentStatus(name, "REVIEW");
      this._createPr(name);
    } else {
      // auto
      if (assessment.level === "LOW") {
        this.state.updateAgentStatus(name, "ACCEPTED");
        this.workspaceManager.remove(name);
        this.state.archiveAgent(name);
      } else {
        this.state.updateAgentStatus(name, "REVIEW");
        this._createPr(name);
      }
    }

    // 6. 触发 DAG 依赖解析
    this._triggerDepResolution(name);
  }

  accept(name: string): void {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);

    this.state.updateAgentStatus(name, "ACCEPTED");
    this.workspaceManager.remove(name);
    this.state.archiveAgent(name);
    this._triggerDepResolution(name);
  }

  reject(name: string): void {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);

    // 尝试回滚已合并的改动
    try {
      execFileSync("git", ["merge", "--abort"], {
        cwd: this.repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // 不在 merge 中，用记录的 merge_commit_sha 精确 revert
      const sha = agent.merge_commit_sha;
      if (sha) {
        try {
          execFileSync("git", ["revert", "--no-commit", sha], {
            cwd: this.repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          });
          execFileSync("git", ["commit", "-m", `revert: rejected ${name}`], {
            cwd: this.repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          console.warn(`[LoomerApp] reject: could not revert ${sha} for ${name}, manual cleanup may be needed`);
        }
      } else {
        console.warn(`[LoomerApp] reject: no merge_commit_sha for ${name}, cannot auto-revert`);
      }
    }

    this.state.updateAgentStatus(name, "REJECTED");
    this.workspaceManager.remove(name);
    this.state.archiveAgent(name);
    this._triggerDepResolution(name);
  }

  kill(name: string, clean?: boolean): void {
    this.processManager.stop(name);
    if (clean) {
      this.workspaceManager.remove(name);
      this.state.removeAgent(name);
    } else {
      this.state.updateAgentStatus(name, "DONE");
    }
  }

  retry(name: string): void {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);

    const prompt = agent.prompt ?? "";
    const ws = this.workspaceManager.create(
      name,
      this.config.baseBranch || undefined,
    );
    this.processManager.start(name, ws.path, prompt);
    const pid = this.processManager.getPid(name);
    this.state.updateAgent(name, {
      status: "RUNNING",
      pid,
      started_at: Date.now() / 1000,
      worktree: ws.path,
      exit_code: null,
    });
  }

  /** 手动解决冲突后调用：git add + commit + validate → 继续后续流程 */
  resolve(name: string): void {
    const agent = this.state.getAgent(name);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${name}`);
    if (agent.status !== "CONFLICTED") {
      throw new Error(`Agent ${name} is not CONFLICTED (current: ${agent.status})`);
    }

    // 1. 检查是否还有未解决的冲突文件
    try {
      const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: this.repoPath, encoding: "utf-8",
      }).trim();
      if (output) {
        throw new MergeError("Unresolved conflicts remain", output.split("\n").filter(Boolean));
      }
    } catch (err) {
      if (err instanceof MergeError) throw err;
      throw new MergeError("No merge in progress — cannot resolve");
    }

    // 2. git add + commit
    try {
      execFileSync("git", ["add", "-A"], { cwd: this.repoPath, encoding: "utf-8" });
      execFileSync("git", ["commit", "-m", "merge: manually resolved conflicts"], {
        cwd: this.repoPath, encoding: "utf-8",
      });
    } catch {
      throw new MergeError("Failed to commit resolved files");
    }

    // 3. 可选验证
    const hasTsconfig = fs.existsSync(path.join(this.repoPath, "tsconfig.json"));
    const validators = [
      { cmd: "npx", args: ["tsc", "--noEmit"], required: hasTsconfig },
      { cmd: "npx", args: ["biome", "check", "src/"], required: false },
      { cmd: "npx", args: ["vitest", "run"], required: false },
    ];
    for (const v of validators) {
      try {
        execFileSync(v.cmd, v.args, {
          cwd: this.repoPath, encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        if (v.required) throw new MergeError("Validation failed after conflict resolution");
      }
    }

    // 4. 记录 merge commit SHA
    try {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.repoPath, encoding: "utf-8",
      }).trim();
      this.state.updateAgent(name, { merge_commit_sha: sha });
    } catch { /* 忽略 */ }

    // 5. 继续 done() 的后续流程：分级决策
    this.processManager.stop(name);
    const strategy = this.config.mergeStrategy;
    if (strategy === "never") {
      this.state.updateAgentStatus(name, "ACCEPTED");
      this.workspaceManager.remove(name);
      this.state.archiveAgent(name);
      this._triggerDepResolution(name);
    } else if (strategy === "always") {
      this.state.updateAgentStatus(name, "REVIEW");
    } else {
      const assessment = this.safety.assessRisk(
        name,
        agent.worktree || "",
        strategy,
        this.config.autoMergeRules,
        this.config.baseBranch || undefined,
      );
      this.state.updateAgent(name, { risk_assessment: assessment.toDict() });
      if (assessment.level === "LOW") {
        this.state.updateAgentStatus(name, "ACCEPTED");
        this.workspaceManager.remove(name);
        this.state.archiveAgent(name);
        this._triggerDepResolution(name);
      } else {
        this.state.updateAgentStatus(name, "REVIEW");
      }
    }
  }

  // === 查询 ===

  getTaskStatus(id: string): string | undefined {
    return this.state.getAgent(id)?.status;
  }

  status(): AgentInfo[] {
    return this.state.getAllAgents().map(this.agentToInfo.bind(this));
  }

  log(name: string): string {
    return this.processManager.getRecentOutput(name);
  }

  diff(name: string, mode: "stat" | "full" = "stat"): string {
    return this.statusDetector.getDiff(name, mode);
  }

  // === 计划 ===

  runPlan(planPath?: string, prdPath?: string, port?: number): PlanResult {
    // 清理旧计划残留
    const existingPlan = this.state.getPlan();
    if (existingPlan) {
      this.state.clearPlan();
    }

    // 解析
    const spec = prdPath
      ? PlanParser.fromPrdJson(prdPath, this.config.maxConcurrent)
      : planPath
        ? PlanParser.parse(planPath)
        : (() => {
            throw new Error("planPath or prdPath required");
          })();

    // 验证
    DAGValidator.validate(spec);

    // 创建执行器
    this.planExecutor = new PlanExecutor(this, spec);
    this.planExecutor.registerTasks();

    // 预创建所有 worktree
    for (const task of spec.tasks) {
      if (!this.workspaceManager.exists(task.id)) {
        this.workspaceManager.create(
          task.id,
          this.config.baseBranch || undefined,
        );
      }
    }

    // 保存计划
    this.state.setPlan({
      name: spec.name,
      max_concurrent: spec.maxConcurrent,
      tasks: spec.tasks.map((t) => ({
        id: t.id,
        prompt: t.prompt,
        depends_on: t.dependsOn,
      })),
      created_at: Date.now() / 1000,
    });

    // 启动 root 任务（通过 PlanExecutor 统一处理 maxConcurrent）
    this.planExecutor.launchReady();

    // 启动 StatusDetector 轮询
    this.startStatusPolling();

    // 启动 Web 仪表盘（附属，可独立关闭）
    this.startServer(port ?? this.config.defaultPort);

    return { name: spec.name, taskCount: spec.tasks.length };
  }

  planStatus(): PlanProgress | null {
    if (this.planExecutor) {
      return this.planExecutor.getProgress();
    }
    // 兜底：从 SQLite 重新统计
    return this._countPlanProgress();
  }

  planDag(): DagData | null {
    const plan = this.state.getPlan();
    if (!plan) return null;

    const nodes: Array<{ id: string; status: string }> = [];
    const edges: Array<{ from: string; to: string }> = [];

    for (const task of plan.tasks) {
      const agent = this.state.getAgent(task.id);
      nodes.push({ id: task.id, status: agent?.status ?? "PENDING" });
      for (const dep of task.depends_on) {
        edges.push({ from: dep, to: task.id });
      }
    }

    return { nodes, edges };
  }

  // === 服务器（附属，可独立启停）===

  startServer(port?: number): http.Server | null {
    if (this.server) return this.server;
    const expressApp = createApp(this.config, this);
    const basePort = port ?? this.config.defaultPort;

    // 尝试从 basePort 起递增找可用端口（最多试 100 个）
    let server: http.Server | null = null;
    let actualPort = basePort;
    for (let offset = 0; offset < 100; offset++) {
      actualPort = basePort + offset;
      try {
        server = expressApp.listen(actualPort);
        break;
      } catch {
        continue;
      }
    }

    if (!server) {
      console.error(`No available port in range ${basePort}-${actualPort}. Web dashboard not started.`);
      return null;
    }

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${actualPort} is already in use. Web dashboard not started.`);
        this.server = null;
        this.serverPort = null;
      } else {
        throw err;
      }
    });

    server.on("listening", () => {
      process.stderr.write(`Web dashboard: http://localhost:${actualPort}\n`);
    });

    this.server = server;
    this.serverPort = actualPort;
    return this.server;
  }

  stopServer(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    this.serverPort = null;
  }

  getServerPort(): number | null {
    return this.serverPort;
  }

  startStatusPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      const agents = this.state.getAllAgents();
      for (const agent of agents) {
        if (agent.status === "RUNNING") {
          this.statusDetector.getStatus(agent.name);
        }
      }
      // 全终态且无 REVIEW/CONFLICTED → 自动关闭 web
      this._autoStopWebIfDone();
    }, 5000);
  }

  private _autoStopWebIfDone(): void {
    if (!this.server) return;
    const agents = this.state.getAllAgents();
    const needsHuman = agents.some(
      (a) => a.status === "REVIEW" || a.status === "CONFLICTED",
    );
    const hasActive = agents.some(
      (a) =>
        a.status === "RUNNING" ||
        a.status === "PENDING" ||
        a.status === "DONE",
    );
    if (!needsHuman && !hasActive) {
      this.stopServer();
    }
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopServer();
    // 杀所有子进程
    for (const name of this.processManager.list()) {
      this.processManager.stop(name);
    }
    this.processManager.dispose();
    this.state.close();
  }

  // === 私有方法 ===

  _mergeAgent(name: string, worktreePath: string): void {
    // 并发 merge 串行化（设计规范 §6.1 约束 4）
    if (this._mergeLocked) {
      this._mergeQueue.push({ name, worktreePath });
      return;
    }
    this._mergeLocked = true;
    try {
      this._doMergeAgent(name, worktreePath);
    } finally {
      this._mergeLocked = false;
      const next = this._mergeQueue.shift();
      if (next) {
        this._mergeAgent(next.name, next.worktreePath);
      }
    }
  }

  private _doMergeAgent(name: string, worktreePath: string): void {
    // git add -A（agent 可能不 commit）
    execFileSync("git", ["add", "-A"], { cwd: worktreePath, encoding: "utf-8" });

    // 检查是否有变更（用 status --porcelain 而非 diff --cached，因为 agent 可能已自行 commit）
    let hasChanges = false;
    try {
      const statusOutput = execFileSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      hasChanges = statusOutput.length > 0;
    } catch {
      hasChanges = true; // status 失败时保守假设有变更
    }
    if (!hasChanges) {
      // 即使 worktree 无未提交变更，分支也可能有新 commit（agent 已自行 commit）
      const baseBranch = this.config.baseBranch || "master";
      try {
        const logOutput = execFileSync("git", ["log", `${baseBranch}..${name}`, "--oneline"], {
          cwd: this.repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (!logOutput) return; // 真正无新 commit，跳过 merge
      } catch {
        // log 检查失败，继续尝试 merge
      }
    }

    // auto-commit（在 agent 分支上）— 仅在有 uncommitted changes 时
    if (hasChanges) {
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      try {
        execFileSync("git", ["commit", "-m", `feat: ${safeName} auto-commit`], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        console.warn(`[_doMergeAgent] auto-commit failed for ${name}: ${err}`);
      }
    }

    // merge 到主分支 — 在主仓库中执行
    const baseBranch = this.config.baseBranch || "master";
    try {
      execFileSync("git", ["merge", "--no-ff", name, "-m", `Merge ${name} into ${baseBranch}`], {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    } catch {
      // merge 冲突 → 尝试自动解决
      const resolved = this._autoResolveConflicts(this.repoPath);
      if (!resolved) {
        try {
          execFileSync("git", ["merge", "--abort"], {
            cwd: this.repoPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // 回滚失败
        }
        // 获取冲突文件列表
        let conflictFiles: string[] = [];
        try {
          const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
            cwd: this.repoPath,
            encoding: "utf-8",
          }).trim();
          conflictFiles = output ? output.split("\n").filter(Boolean) : [];
        } catch {
          // 忽略
        }
        throw new MergeError(`Merge conflict for ${name}`, conflictFiles);
      }
    }

    // 记录 merge commit SHA 供 reject 回滚使用
    try {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.repoPath, encoding: "utf-8",
      }).trim();
      this.state.updateAgent(name, { merge_commit_sha: sha });
    } catch {
      // 忽略
    }
  }

  _autoResolveConflicts(mergeDir: string): boolean {
    // 识别冲突文件
    let conflictFiles: string[] = [];
    try {
      const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: mergeDir,
        encoding: "utf-8",
      }).trim();
      conflictFiles = output ? output.split("\n").filter(Boolean) : [];
    } catch {
      return false;
    }

    if (conflictFiles.length === 0) return true;

    // 逐文件按类型分派
    for (const file of conflictFiles) {
      const filePath = `${mergeDir}/${file}`;
      try {
        if (file === "package.json" || file.endsWith("/package.json")) {
          // package.json：用 git show 获取完整 ours/theirs 版本（而非冲突块）
          const baseBranch = this.config.baseBranch || "master";
          let oursContent = "";
          let theirsContent = "";
          try {
            oursContent = execFileSync("git", ["show", `HEAD:${file}`], {
              cwd: mergeDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
          } catch {
            // HEAD 版本不存在（新文件）→ ours 为空
          }
          try {
            theirsContent = execFileSync("git", ["show", `MERGE_HEAD:${file}`], {
              cwd: mergeDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
          } catch {
            // MERGE_HEAD 版本不存在 → 无法解决
            return false;
          }
          const resolved = autoResolveConflictFile(file, oursContent, theirsContent);
          if (resolved === null) return false;
          fs.writeFileSync(filePath, resolved);
        } else {
          // 非 package.json：用冲突标记提取 ours/theirs 块
          const content = fs.readFileSync(filePath, "utf-8");
          const { ours, theirs } = this._extractConflictSides(content);
          if (ours === null || theirs === null) return false;
          const resolved = autoResolveConflictFile(file, ours, theirs);
          if (resolved === null) return false;
          fs.writeFileSync(filePath, resolved);
        }
      } catch {
        return false;
      }
    }

    // git add 所有解决后的文件
    try {
      execFileSync("git", ["add", "-A"], { cwd: mergeDir, encoding: "utf-8" });
    } catch {
      return false;
    }

    // 验证：tsconfig.json 存在时 tsc required，否则 optional；biome/vitest 一律 optional
    const hasTsconfig = fs.existsSync(path.join(mergeDir, "tsconfig.json"));
    const validators = [
      { cmd: "npx", args: ["tsc", "--noEmit"], label: "tsc", required: hasTsconfig },
      { cmd: "npx", args: ["biome", "check", "src/"], label: "biome", required: false },
      { cmd: "npx", args: ["vitest", "run"], label: "vitest", required: false },
    ];
    for (const v of validators) {
      try {
        execFileSync(v.cmd, v.args, {
          cwd: mergeDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        if (v.required) {
          try {
            execFileSync("git", ["merge", "--abort"], {
              cwd: mergeDir,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch {
            // 忽略
          }
          return false;
        }
        // optional validator failure → continue (tool may not be installed)
      }
    }

    // 验证通过 → auto commit
    try {
      execFileSync("git", ["commit", "-m", "merge: auto-resolved conflicts"], {
        cwd: mergeDir,
        encoding: "utf-8",
      });
    } catch {
      return false;
    }

    return true;
  }

  _extractConflictSides(content: string): {
    ours: string | null;
    theirs: string | null;
  } {
    // 解析 git conflict markers: <<<<<<< ... ======= ... >>>>>>>
    const oursParts: string[] = [];
    const theirsParts: string[] = [];
    let inOurs = false;
    let inTheirs = false;

    for (const line of content.split("\n")) {
      if (line.startsWith("<<<<<<<")) {
        inOurs = true;
        continue;
      }
      if (line.startsWith("=======")) {
        inOurs = false;
        inTheirs = true;
        continue;
      }
      if (line.startsWith(">>>>>>>")) {
        inTheirs = false;
        continue;
      }
      if (inOurs) oursParts.push(line);
      if (inTheirs) theirsParts.push(line);
    }

    if (oursParts.length === 0 && theirsParts.length === 0) {
      return { ours: null, theirs: null };
    }

    return {
      ours: oursParts.join("\n"),
      theirs: theirsParts.join("\n"),
    };
  }

  _createPr(name: string): string | null {
    if (!this.config.createPr) return null;
    try {
      const agent = this.state.getAgent(name);
      const prompt = agent?.prompt ?? name;
      const title = prompt.slice(0, 70);
      const output = execFileSync(
        "gh", ["pr", "create", "--title", title, "--body", `## Task: ${name}\n\n${prompt}`, "--head", name],
        { cwd: this.repoPath, encoding: "utf-8" },
      ).trim();
      const prUrl = output.split("\n").pop() ?? null;
      if (prUrl) {
        this.state.updateAgent(name, { pr_url: prUrl });
      }
      return prUrl;
    } catch (err) {
      console.warn(`[LoomerApp] PR creation failed for ${name}: ${err}`);
      return null;
    }
  }

  _triggerDepResolution(name: string): void {
    if (this.planExecutor) {
      this.planExecutor.onTaskDone(name);
    }
  }

  _countPlanProgress(): PlanProgress | null {
    const plan = this.state.getPlan();
    if (!plan) return null;

    let done = 0;
    let running = 0;
    let pending = 0;
    let crashed = 0;
    let conflicted = 0;
    let stale = 0;
    let review = 0;

    for (const task of plan.tasks) {
      const agent = this.state.getAgent(task.id);
      const status = agent?.status ?? "PENDING";
      switch (status) {
        case "DONE":
        case "ACCEPTED":
          done++;
          break;
        case "RUNNING":
          running++;
          break;
        case "PENDING":
          pending++;
          break;
        case "CRASHED":
          crashed++;
          break;
        case "CONFLICTED":
          conflicted++;
          break;
        case "STALE":
          stale++;
          break;
        case "REVIEW":
        case "REJECTED":
          review++;
          break;
      }
    }

    return {
      plan: plan.name,
      total: plan.tasks.length,
      done,
      running,
      pending,
      crashed,
      conflicted,
      stale,
      review,
    };
  }

  private agentToInfo(agent: AgentData): AgentInfo {
    return {
      name: agent.name,
      status: agent.status,
      branch: agent.branch ?? undefined,
      prompt: agent.prompt ?? undefined,
      worktree: agent.worktree ?? undefined,
      started_at: agent.started_at ?? undefined,
      pid: agent.pid,
      exit_code: agent.exit_code,
      risk_assessment: agent.risk_assessment,
      pr_url: agent.pr_url,
      archived: agent.archived,
      depends_on: agent.depends_on,
      plan: agent.plan ?? undefined,
    };
  }
}
