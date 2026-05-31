import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import type { LoomerConfig } from "./config.js";
import { AgentNotFoundError } from "./errors.js";

// === 类型 ===

export interface Agent {
  name: string;
  status: string;
  branch: string | null;
  prompt: string | null;
  worktree: string | null;
  started_at: number | null;
  pid: number | null;
  exit_code: number | null;
  risk_assessment: Record<string, unknown> | null;
  last_output: string | null;
  pr_url: string | null;
  archived: boolean;
  depends_on: string[];
  plan: string | null;
}

export interface TaskSpec {
  id: string;
  prompt: string;
  dependsOn: string[];
}

export interface PlanData {
  name: string;
  max_concurrent: number;
  tasks: TaskSpec[];
  created_at: number;
}

export interface State {
  agents: Agent[];
  plan: PlanData | null;
}

// === Schema ===

const SCHEMA_SQL = `
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
  archived INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT,
  plan TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  name TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL DEFAULT 5,
  tasks TEXT NOT NULL,
  created_at REAL NOT NULL
);
`;

// === 序列化辅助 ===

function toArchivedInt(v: unknown): 0 | 1 {
  return v === 1 || v === true ? 1 : 0;
}

function toJsonString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

// === 行 → Agent 转换（防御性处理缺失字段）===

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    name: row.name as string,
    status: (row.status as string) ?? "PENDING",
    branch: (row.branch as string | null) ?? null,
    prompt: (row.prompt as string | null) ?? null,
    worktree: (row.worktree as string | null) ?? null,
    started_at: (row.started_at as number | null) ?? null,
    pid: typeof row.pid === "number" ? row.pid : null,
    exit_code: typeof row.exit_code === "number" ? row.exit_code : null,
    risk_assessment: parseJson<Record<string, unknown> | null>(
      row.risk_assessment,
      null,
    ),
    last_output: (row.last_output as string | null) ?? null,
    pr_url: (row.pr_url as string | null) ?? null,
    archived: row.archived === 1 || row.archived === true,
    depends_on: parseJson<string[]>(row.depends_on, []),
    plan: (row.plan as string | null) ?? null,
  };
}

function rowToPlan(row: Record<string, unknown>): PlanData {
  return {
    name: row.name as string,
    max_concurrent:
      typeof row.max_concurrent === "number" ? row.max_concurrent : 5,
    tasks: parseJson<TaskSpec[]>(row.tasks, []),
    created_at:
      typeof row.created_at === "number" ? row.created_at : 0,
  };
}

// === repo 路径隔离 ===

function repoHash(repoPath: string): string {
  return crypto.createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
}

// === StateStore ===

export class StateStore {
  readonly db: Database.Database;

  constructor(config: LoomerConfig, repoPath: string) {
    const stateDir = config.resolvedStateDir ?? config.stateDir;
    const dbPath = path.join(stateDir, `${repoHash(repoPath)}.db`);

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA_SQL);
  }

  // --- 核心方法 ---

  load(): State {
    const agents = this.db
      .prepare("SELECT * FROM agents")
      .all()
      .map((r) => rowToAgent(r as Record<string, unknown>));

    const planRow = this.db
      .prepare("SELECT * FROM plans")
      .get() as Record<string, unknown> | undefined;

    return {
      agents,
      plan: planRow ? rowToPlan(planRow) : null,
    };
  }

  /** Full state replacement. Use only for initial load or full restore;
   *  for partial updates use updateAgent() to avoid lost-update races. */
  save(state: State): void {
    const txn = this.db.transaction(() => {
      this.db.exec("DELETE FROM agents");
      this.db.exec("DELETE FROM plans");

      const insertAgent = this.db.prepare(`
        INSERT INTO agents (name, status, branch, prompt, worktree,
          started_at, pid, exit_code, risk_assessment, last_output,
          pr_url, archived, depends_on, plan)
        VALUES (@name, @status, @branch, @prompt, @worktree,
          @started_at, @pid, @exit_code, @risk_assessment, @last_output,
          @pr_url, @archived, @depends_on, @plan)
      `);

      for (const a of state.agents) {
        insertAgent.run({
          name: a.name,
          status: a.status,
          branch: a.branch ?? null,
          prompt: a.prompt ?? null,
          worktree: a.worktree ?? null,
          started_at: a.started_at ?? null,
          pid: a.pid ?? null,
          exit_code: a.exit_code ?? null,
          risk_assessment: toJsonString(a.risk_assessment),
          last_output: a.last_output ?? null,
          pr_url: a.pr_url ?? null,
          archived: toArchivedInt(a.archived),
          depends_on: a.depends_on.length ? JSON.stringify(a.depends_on) : null,
          plan: a.plan ?? null,
        });
      }

      if (state.plan) {
        this.db
          .prepare(
            `INSERT INTO plans (name, max_concurrent, tasks, created_at)
             VALUES (@name, @max_concurrent, @tasks, @created_at)`,
          )
          .run({
            name: state.plan.name,
            max_concurrent: state.plan.max_concurrent,
            tasks: JSON.stringify(state.plan.tasks),
            created_at: state.plan.created_at,
          });
      }
    });
    txn();
  }

  updateAgent(name: string, fields: Record<string, unknown>): void {
    if (fields.name !== undefined && fields.name !== name) {
      throw new Error(
        `Agent name mismatch: path param "${name}" vs fields.name "${fields.name as string}"`,
      );
    }

    // 原子 upsert：INSERT on new, UPDATE on conflict
    // 新字段用传入值，未传字段保留现有值（coalesce）
    this.db
      .prepare(
        `INSERT INTO agents (name, status, branch, prompt, worktree,
          started_at, pid, exit_code, risk_assessment, last_output,
          pr_url, archived, depends_on, plan)
        VALUES (@name, @status, @branch, @prompt, @worktree,
          @started_at, @pid, @exit_code, @risk_assessment, @last_output,
          @pr_url, @archived, @depends_on, @plan)
        ON CONFLICT(name) DO UPDATE SET
          status = coalesce(@status, agents.status),
          branch = coalesce(@branch, agents.branch),
          prompt = coalesce(@prompt, agents.prompt),
          worktree = coalesce(@worktree, agents.worktree),
          started_at = coalesce(@started_at, agents.started_at),
          pid = CASE WHEN @pid IS NOT NULL THEN @pid ELSE agents.pid END,
          exit_code = CASE WHEN @exit_code IS NOT NULL THEN @exit_code ELSE agents.exit_code END,
          risk_assessment = coalesce(@risk_assessment, agents.risk_assessment),
          last_output = coalesce(@last_output, agents.last_output),
          pr_url = coalesce(@pr_url, agents.pr_url),
          archived = CASE WHEN @archived_set = 1 THEN @archived ELSE agents.archived END,
          depends_on = coalesce(@depends_on, agents.depends_on),
          plan = coalesce(@plan, agents.plan)`,
      )
      .run({
        name,
        status: (fields.status as string) ?? null,
        branch: (fields.branch as string) ?? null,
        prompt: (fields.prompt as string) ?? null,
        worktree: (fields.worktree as string) ?? null,
        started_at: (fields.started_at as number) ?? null,
        pid: (fields.pid as number) ?? null,
        exit_code: (fields.exit_code as number) ?? null,
        risk_assessment: toJsonString(fields.risk_assessment),
        last_output: (fields.last_output as string) ?? null,
        pr_url: (fields.pr_url as string) ?? null,
        archived_set: fields.archived !== undefined ? 1 : 0,
        archived: toArchivedInt(fields.archived),
        depends_on: toJsonString(fields.depends_on),
        plan: (fields.plan as string) ?? null,
      });
  }

  updateAgentStatus(name: string, status: string): void {
    const result = this.db
      .prepare("UPDATE agents SET status = ? WHERE name = ?")
      .run(status, name);
    if (result.changes === 0) {
      throw new AgentNotFoundError(`Agent not found: ${name}`);
    }
  }

  removeAgent(name: string): void {
    this.db.prepare("DELETE FROM agents WHERE name = ?").run(name);
  }

  getAgent(name: string): Agent | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    return row ? rowToAgent(row) : null;
  }

  getPlan(): PlanData | null {
    const row = this.db
      .prepare("SELECT * FROM plans")
      .get() as Record<string, unknown> | undefined;
    return row ? rowToPlan(row) : null;
  }

  setPlan(plan: PlanData): void {
    this.db.exec("DELETE FROM plans");
    this.db
      .prepare(
        `INSERT INTO plans (name, max_concurrent, tasks, created_at)
         VALUES (@name, @max_concurrent, @tasks, @created_at)`,
      )
      .run({
        name: plan.name,
        max_concurrent: plan.max_concurrent,
        tasks: JSON.stringify(plan.tasks),
        created_at: plan.created_at,
      });
  }

  clearPlan(): void {
    this.db.exec("DELETE FROM plans");
  }

  getPendingAgents(): Agent[] {
    return this.db
      .prepare(
        "SELECT * FROM agents WHERE status = 'PENDING' AND archived = 0",
      )
      .all()
      .map((r) => rowToAgent(r as Record<string, unknown>));
  }

  getRunningCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM agents WHERE status = 'RUNNING' AND archived = 0",
      )
      .get() as Record<string, unknown>;
    return (row.cnt as number) ?? 0;
  }

  // --- Archive ---

  archiveAgent(name: string): void {
    const result = this.db
      .prepare("UPDATE agents SET archived = 1 WHERE name = ?")
      .run(name);
    if (result.changes === 0) {
      throw new AgentNotFoundError(`Agent not found: ${name}`);
    }
  }

  getActiveAgents(): Agent[] {
    return this.db
      .prepare("SELECT * FROM agents WHERE archived = 0")
      .all()
      .map((r) => rowToAgent(r as Record<string, unknown>));
  }

  getArchivedAgents(): Agent[] {
    return this.db
      .prepare("SELECT * FROM agents WHERE archived = 1")
      .all()
      .map((r) => rowToAgent(r as Record<string, unknown>));
  }

  // --- 生命周期 ---

  close(): void {
    try {
      this.db.close();
    } catch (e) {
      if (!(e instanceof Error && /already closed/i.test(e.message))) {
        console.error("Unexpected error closing database:", e);
      }
    }
  }
}
