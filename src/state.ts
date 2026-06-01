import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { LoomerConfig } from "./config.js";
import { AgentNotFoundError } from "./errors.js";
import type { IAgentData, IStateStore, Status } from "./status.js";

import type { RiskAssessmentData } from "./types/web.js";

export interface AgentData {
  name: string;
  status: string;
  branch: string | null;
  prompt: string | null;
  worktree: string | null;
  started_at: number | null;
  pid: number | null;
  exit_code: number | null;
  risk_assessment: RiskAssessmentData | null;
  last_output: string | null;
  pr_url: string | null;
  merge_commit_sha: string | null;
  archived: boolean;
  depends_on: string[];
  plan: string | null;
}

export interface PlanData {
  name: string;
  max_concurrent: number;
  tasks: Array<{ id: string; prompt: string; depends_on: string[] }>;
  created_at: number;
}

// SQL 创建语句
const CREATE_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PENDING',
  branch TEXT,
  prompt TEXT,
  worktree TEXT,
  started_at REAL,
  pid INTEGER,
  exit_code INTEGER,
  risk_assessment TEXT,
  last_output TEXT,
  pr_url TEXT,
  merge_commit_sha TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT,
  plan TEXT
)`;

const CREATE_PLANS = `
CREATE TABLE IF NOT EXISTS plans (
  name TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL DEFAULT 5,
  tasks TEXT NOT NULL,
  created_at REAL NOT NULL
)`;

function repoDir(config: LoomerConfig, repoPath: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(repoPath)
    .digest("hex")
    .slice(0, 12);
  return path.join(config.resolvedStateDir, hash);
}

function rowToAgent(row: Record<string, unknown>): AgentData {
  return {
    name: row.name as string,
    status: (row.status as string) ?? "PENDING",
    branch: (row.branch as string | null) ?? null,
    prompt: (row.prompt as string | null) ?? null,
    worktree: (row.worktree as string | null) ?? null,
    started_at: (row.started_at as number | null) ?? null,
    pid: (row.pid as number | null) ?? null,
    exit_code: (row.exit_code as number | null) ?? null,
    risk_assessment: row.risk_assessment
      ? (JSON.parse(row.risk_assessment as string) as RiskAssessmentData)
      : null,
    last_output: (row.last_output as string | null) ?? null,
    pr_url: (row.pr_url as string | null) ?? null,
    merge_commit_sha: (row.merge_commit_sha as string | null) ?? null,
    archived: Boolean(row.archived),
    depends_on: row.depends_on
      ? (JSON.parse(row.depends_on as string) as string[])
      : [],
    plan: (row.plan as string | null) ?? null,
  };
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(config: LoomerConfig, repoPath: string) {
    const dir = repoDir(config, repoPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(path.join(dir, "state.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(CREATE_AGENTS);
    this.db.exec(CREATE_PLANS);
  }

  close(): void {
    this.db.close();
  }

  // --- Agent CRUD ---

  getAgent(name: string): AgentData | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    return row ? rowToAgent(row) : null;
  }

  updateAgent(name: string, fields: Record<string, unknown>): void {
    const doUpdate = this.db.transaction(() => {
      const existing = this.getAgent(name);
      if (existing) {
      const merged: Record<string, unknown> = {
        ...this.agentToRow(existing),
        ...this.fieldsToRow(fields),
        name,
      };
      this.db
        .prepare(
          "UPDATE agents SET status=?, branch=?, prompt=?, worktree=?, started_at=?, pid=?, exit_code=?, risk_assessment=?, last_output=?, pr_url=?, merge_commit_sha=?, archived=?, depends_on=?, plan=? WHERE name=?",
        )
        .run(
          merged.status as string,
          merged.branch as string | null,
          merged.prompt as string | null,
          merged.worktree as string | null,
          merged.started_at as number | null,
          merged.pid as number | null,
          merged.exit_code as number | null,
          merged.risk_assessment as string | null,
          merged.last_output as string | null,
          merged.pr_url as string | null,
          merged.merge_commit_sha as string | null,
          merged.archived as number,
          merged.depends_on as string,
          merged.plan as string | null,
          name,
        );
    } else {
      const row = this.fieldsToRow(fields);
      this.db
        .prepare(
          "INSERT INTO agents (name, status, branch, prompt, worktree, started_at, pid, exit_code, risk_assessment, last_output, pr_url, merge_commit_sha, archived, depends_on, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          name,
          row.status ?? "PENDING",
          row.branch ?? null,
          row.prompt ?? null,
          row.worktree ?? null,
          row.started_at ?? null,
          row.pid ?? null,
          row.exit_code ?? null,
          row.risk_assessment ?? null,
          row.last_output ?? null,
          row.pr_url ?? null,
          row.merge_commit_sha ?? null,
          row.archived ?? 0,
          row.depends_on ?? "[]",
          row.plan ?? null,
        );
    }
    });
    doUpdate();
  }

  updateAgentStatus(name: string, status: string): void {
    const existing = this.getAgent(name);
    if (!existing) throw new AgentNotFoundError(`Agent not found: ${name}`);
    this.db
      .prepare("UPDATE agents SET status = ? WHERE name = ?")
      .run(status, name);
  }

  removeAgent(name: string): void {
    this.db.prepare("DELETE FROM agents WHERE name = ?").run(name);
  }

  // --- 查询 ---

  getPendingAgents(): AgentData[] {
    return this.getAllAgents().filter((a) => a.status === "PENDING");
  }

  getRunningCount(): number {
    return this.getAllAgents().filter((a) => a.status === "RUNNING").length;
  }

  getActiveAgents(): AgentData[] {
    return this.getAllAgents().filter((a) => !a.archived);
  }

  getArchivedAgents(): AgentData[] {
    return this.getAllAgents().filter((a) => a.archived);
  }

  getAllAgents(): AgentData[] {
    const rows = this.db.prepare("SELECT * FROM agents").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToAgent);
  }

  // --- Archive ---

  archiveAgent(name: string): void {
    this.db.prepare("UPDATE agents SET archived = 1 WHERE name = ?").run(name);
  }

  // --- Plan ---

  getPlan(): PlanData | null {
    const row = this.db.prepare("SELECT * FROM plans LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      name: row.name as string,
      max_concurrent: (row.max_concurrent as number) ?? 5,
      tasks: JSON.parse(row.tasks as string) as PlanData["tasks"],
      created_at: row.created_at as number,
    };
  }

  setPlan(plan: PlanData): void {
    this.db.prepare("DELETE FROM plans").run();
    this.db
      .prepare(
        "INSERT INTO plans (name, max_concurrent, tasks, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        plan.name,
        plan.max_concurrent,
        JSON.stringify(plan.tasks),
        plan.created_at,
      );
  }

  clearPlan(): void {
    this.db.prepare("DELETE FROM plans").run();
  }

  // --- IStateStore 适配器（供 StatusDetector 使用）---

  asIStateStore(): IStateStore {
    return {
      getAgent: (name: string): IAgentData | null => {
        const agent = this.getAgent(name);
        if (!agent) return null;
        return this.agentToIAgentData(agent);
      },
      updateAgentStatus: (name: string, status: Status): void => {
        this.updateAgentStatus(name, status);
      },
      getAllAgents: (): IAgentData[] => {
        return this.getAllAgents().map((a) => this.agentToIAgentData(a));
      },
    };
  }

  private agentToIAgentData(agent: AgentData): IAgentData {
    return {
      name: agent.name,
      status: agent.status,
      worktree: agent.worktree ?? "",
      prompt: agent.prompt,
      started_at: agent.started_at ?? 0,
      pid: agent.pid,
      exit_code: agent.exit_code,
      risk_assessment: agent.risk_assessment ? JSON.stringify(agent.risk_assessment) : null,
      pr_url: agent.pr_url,
      archived: agent.archived ? 1 : 0,
      depends_on: agent.depends_on ? JSON.stringify(agent.depends_on) : null,
      plan: agent.plan,
    };
  }

  // --- 内部转换 ---

  private agentToRow(agent: AgentData): Record<string, unknown> {
    return {
      status: agent.status,
      branch: agent.branch ?? null,
      prompt: agent.prompt ?? null,
      worktree: agent.worktree ?? null,
      started_at: agent.started_at ?? null,
      pid: agent.pid ?? null,
      exit_code: agent.exit_code ?? null,
      risk_assessment: agent.risk_assessment
        ? JSON.stringify(agent.risk_assessment)
        : null,
      last_output: agent.last_output ?? null,
      pr_url: agent.pr_url ?? null,
      merge_commit_sha: agent.merge_commit_sha ?? null,
      archived: agent.archived ? 1 : 0,
      depends_on: JSON.stringify(agent.depends_on ?? []),
      plan: agent.plan ?? null,
    };
  }

  private fieldsToRow(
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if ("status" in fields) row.status = fields.status;
    if ("branch" in fields) row.branch = fields.branch;
    if ("prompt" in fields) row.prompt = fields.prompt;
    if ("worktree" in fields) row.worktree = fields.worktree;
    if ("started_at" in fields) row.started_at = fields.started_at;
    if ("pid" in fields) row.pid = fields.pid;
    if ("exit_code" in fields) row.exit_code = fields.exit_code;
    if ("risk_assessment" in fields) {
      row.risk_assessment =
        fields.risk_assessment && typeof fields.risk_assessment === "object"
          ? JSON.stringify(fields.risk_assessment)
          : (fields.risk_assessment as string | null);
    }
    if ("last_output" in fields) row.last_output = fields.last_output;
    if ("pr_url" in fields) row.pr_url = fields.pr_url;
    if ("merge_commit_sha" in fields) row.merge_commit_sha = fields.merge_commit_sha;
    if ("archived" in fields) row.archived = fields.archived ? 1 : 0;
    if ("depends_on" in fields)
      row.depends_on = JSON.stringify(fields.depends_on);
    if ("plan" in fields) row.plan = fields.plan;
    return row;
  }
}
