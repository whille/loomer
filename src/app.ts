import { execSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import type { LoomerConfig } from "./config.js";
import { AgentNotFoundError, MergeError } from "./errors.js";
import { autoResolveConflictFile } from "./merge.js";
import { DAGValidator, PlanExecutor, PlanParser } from "./plan.js";
import type { ProcessManager } from "./process.js";
import { type RiskAssessment, SafetyChecks } from "./safety.js";
import type { AgentData, StateStore } from "./state.js";
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
import type { WorkspaceManager } from "./workspace.js";

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
  private pollTimer: ReturnType<typeof setInterval> | null = null;

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
      this._createPr(name, agent.worktree);
    } else {
      // auto
      if (assessment.level === "LOW") {
        this.state.updateAgentStatus(name, "ACCEPTED");
        this.workspaceManager.remove(name);
        this.state.archiveAgent(name);
      } else {
        this.state.updateAgentStatus(name, "REVIEW");
        this._createPr(name, agent.worktree);
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

  // === 查询 ===

  status(): AgentInfo[] {
    return this.state.getAllAgents().map(this.agentToInfo.bind(this));
  }

  log(name: string, lines = 50): string {
    return this.processManager.getRecentOutput(name, lines);
  }

  diff(name: string, mode: "stat" | "full" = "stat"): string {
    return this.statusDetector.getDiff(name, mode);
  }

  // === 计划 ===

  runPlan(planPath?: string, prdPath?: string): PlanResult {
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

    // 启动 root 任务（dependsOn=[]）
    for (const task of spec.tasks) {
      if (task.dependsOn.length === 0) {
        this.start(task.id, task.prompt);
      }
    }

    // 启动内嵌 Web 服务器
    this.startServer(this.config.defaultPort);

    // 启动 StatusDetector 轮询
    this.startStatusPolling();

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

  // === 服务器 ===

  startServer(port?: number): http.Server {
    if (this.server) return this.server;
    const expressApp = createApp(this.config, this);
    this.server = expressApp.listen(port ?? this.config.defaultPort);
    return this.server;
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
    }, 5000);
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // === 私有方法 ===

  _mergeAgent(name: string, worktreePath: string): void {
    // git add -A（agent 可能不 commit）
    execSync("git add -A", { cwd: worktreePath, encoding: "utf-8" });

    // 检查是否有变更
    try {
      execSync("git diff --cached --quiet", {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      return; // 无变更，跳过 commit
    } catch {
      // diff --cached --quiet exit ≠0 表示有变更
    }

    // auto-commit
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    execSync(`git commit -m "feat: ${safeName} auto-commit"`, {
      cwd: worktreePath,
      encoding: "utf-8",
    });

    // merge 到主分支
    try {
      const baseBranch = this.config.baseBranch || "master";
      execSync(`git checkout ${baseBranch}`, {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      execSync(`git merge ${name}`, { cwd: worktreePath, encoding: "utf-8" });
    } catch {
      // merge 冲突 → 尝试自动解决
      const resolved = this._autoResolveConflicts(worktreePath);
      if (!resolved) {
        try {
          execSync("git merge --abort", {
            cwd: worktreePath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // 回滚失败
        }
        // 获取冲突文件列表
        let conflictFiles: string[] = [];
        try {
          const output = execSync("git diff --name-only --diff-filter=U", {
            cwd: worktreePath,
            encoding: "utf-8",
          }).trim();
          conflictFiles = output ? output.split("\n").filter(Boolean) : [];
        } catch {
          // 忽略
        }
        throw new MergeError(`Merge conflict for ${name}`, conflictFiles);
      }
    }
  }

  _autoResolveConflicts(worktreePath: string): boolean {
    // 识别冲突文件
    let conflictFiles: string[] = [];
    try {
      const output = execSync("git diff --name-only --diff-filter=U", {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      conflictFiles = output ? output.split("\n").filter(Boolean) : [];
    } catch {
      return false;
    }

    if (conflictFiles.length === 0) return true;

    // 逐文件按类型分派
    for (const file of conflictFiles) {
      const filePath = `${worktreePath}/${file}`;
      try {
        const content = execSync(`cat "${filePath}"`, {
          cwd: worktreePath,
          encoding: "utf-8",
        });
        const { ours, theirs } = this._extractConflictSides(content);

        if (ours === null || theirs === null) return false;

        const resolved = autoResolveConflictFile(file, ours, theirs);
        if (resolved === null) return false;

        // 写入解决后的内容
        const { writeFileSync } = require("node:fs");
        writeFileSync(filePath, resolved);
      } catch {
        return false;
      }
    }

    // git add 所有解决后的文件
    try {
      execSync("git add -A", { cwd: worktreePath, encoding: "utf-8" });
    } catch {
      return false;
    }

    // 验证：tsc --noEmit
    try {
      execSync("npx tsc --noEmit", {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // 验证失败 → 回退
      try {
        execSync("git merge --abort", {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // 忽略
      }
      return false;
    }

    // 验证通过 → auto commit
    try {
      execSync('git commit -m "merge: auto-resolved conflicts"', {
        cwd: worktreePath,
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

  _createPr(name: string, worktreePath: string): string | null {
    if (!this.config.createPr) return null;
    try {
      const agent = this.state.getAgent(name);
      const prompt = agent?.prompt ?? name;
      const title = prompt.slice(0, 70);
      const output = execSync(
        `gh pr create --title "${title}" --body "## Task: ${name}\n\n${prompt}" --head ${name}`,
        { cwd: worktreePath, encoding: "utf-8" },
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
