import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { AgentNotFoundError } from "./errors.js";
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
function repoDir(config, repoPath) {
    const hash = crypto
        .createHash("sha256")
        .update(repoPath)
        .digest("hex")
        .slice(0, 12);
    return path.join(config.resolvedStateDir, hash);
}
function rowToAgent(row) {
    return {
        name: row.name,
        status: row.status ?? "PENDING",
        branch: row.branch ?? null,
        prompt: row.prompt ?? null,
        worktree: row.worktree ?? null,
        started_at: row.started_at ?? null,
        pid: row.pid ?? null,
        exit_code: row.exit_code ?? null,
        risk_assessment: row.risk_assessment
            ? JSON.parse(row.risk_assessment)
            : null,
        last_output: row.last_output ?? null,
        pr_url: row.pr_url ?? null,
        merge_commit_sha: row.merge_commit_sha ?? null,
        archived: Boolean(row.archived),
        depends_on: row.depends_on
            ? JSON.parse(row.depends_on)
            : [],
        plan: row.plan ?? null,
    };
}
export class StateStore {
    db;
    constructor(config, repoPath) {
        const dir = repoDir(config, repoPath);
        fs.mkdirSync(dir, { recursive: true });
        this.db = new Database(path.join(dir, "state.db"));
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("busy_timeout = 5000");
        this.db.exec(CREATE_AGENTS);
        this.db.exec(CREATE_PLANS);
    }
    close() {
        this.db.close();
    }
    // --- Agent CRUD ---
    getAgent(name) {
        const row = this.db
            .prepare("SELECT * FROM agents WHERE name = ?")
            .get(name);
        return row ? rowToAgent(row) : null;
    }
    updateAgent(name, fields) {
        const doUpdate = this.db.transaction(() => {
            const existing = this.getAgent(name);
            if (existing) {
                const merged = {
                    ...this.agentToRow(existing),
                    ...this.fieldsToRow(fields),
                    name,
                };
                this.db
                    .prepare("UPDATE agents SET status=?, branch=?, prompt=?, worktree=?, started_at=?, pid=?, exit_code=?, risk_assessment=?, last_output=?, pr_url=?, merge_commit_sha=?, archived=?, depends_on=?, plan=? WHERE name=?")
                    .run(merged.status, merged.branch, merged.prompt, merged.worktree, merged.started_at, merged.pid, merged.exit_code, merged.risk_assessment, merged.last_output, merged.pr_url, merged.merge_commit_sha, merged.archived, merged.depends_on, merged.plan, name);
            }
            else {
                const row = this.fieldsToRow(fields);
                this.db
                    .prepare("INSERT INTO agents (name, status, branch, prompt, worktree, started_at, pid, exit_code, risk_assessment, last_output, pr_url, merge_commit_sha, archived, depends_on, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                    .run(name, row.status ?? "PENDING", row.branch ?? null, row.prompt ?? null, row.worktree ?? null, row.started_at ?? null, row.pid ?? null, row.exit_code ?? null, row.risk_assessment ?? null, row.last_output ?? null, row.pr_url ?? null, row.merge_commit_sha ?? null, row.archived ?? 0, row.depends_on ?? "[]", row.plan ?? null);
            }
        });
        doUpdate();
    }
    updateAgentStatus(name, status) {
        const existing = this.getAgent(name);
        if (!existing)
            throw new AgentNotFoundError(`Agent not found: ${name}`);
        this.db
            .prepare("UPDATE agents SET status = ? WHERE name = ?")
            .run(status, name);
    }
    removeAgent(name) {
        this.db.prepare("DELETE FROM agents WHERE name = ?").run(name);
    }
    // --- 查询 ---
    getPendingAgents() {
        return this.getAllAgents().filter((a) => a.status === "PENDING");
    }
    getRunningCount() {
        return this.getAllAgents().filter((a) => a.status === "RUNNING").length;
    }
    getActiveAgents() {
        return this.getAllAgents().filter((a) => !a.archived);
    }
    getArchivedAgents() {
        return this.getAllAgents().filter((a) => a.archived);
    }
    getAllAgents() {
        const rows = this.db.prepare("SELECT * FROM agents").all();
        return rows.map(rowToAgent);
    }
    // --- Archive ---
    archiveAgent(name) {
        this.db.prepare("UPDATE agents SET archived = 1 WHERE name = ?").run(name);
    }
    // --- Plan ---
    getPlan() {
        const row = this.db.prepare("SELECT * FROM plans LIMIT 1").get();
        if (!row)
            return null;
        return {
            name: row.name,
            max_concurrent: row.max_concurrent ?? 5,
            tasks: JSON.parse(row.tasks),
            created_at: row.created_at,
        };
    }
    setPlan(plan) {
        this.db.prepare("DELETE FROM plans").run();
        this.db
            .prepare("INSERT INTO plans (name, max_concurrent, tasks, created_at) VALUES (?, ?, ?, ?)")
            .run(plan.name, plan.max_concurrent, JSON.stringify(plan.tasks), plan.created_at);
    }
    clearPlan() {
        this.db.prepare("DELETE FROM plans").run();
    }
    // --- IStateStore 适配器（供 StatusDetector 使用）---
    asIStateStore() {
        return {
            getAgent: (name) => {
                const agent = this.getAgent(name);
                if (!agent)
                    return null;
                return this.agentToIAgentData(agent);
            },
            updateAgentStatus: (name, status) => {
                this.updateAgentStatus(name, status);
            },
            getAllAgents: () => {
                return this.getAllAgents().map((a) => this.agentToIAgentData(a));
            },
        };
    }
    agentToIAgentData(agent) {
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
    agentToRow(agent) {
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
    fieldsToRow(fields) {
        const row = {};
        if ("status" in fields)
            row.status = fields.status;
        if ("branch" in fields)
            row.branch = fields.branch;
        if ("prompt" in fields)
            row.prompt = fields.prompt;
        if ("worktree" in fields)
            row.worktree = fields.worktree;
        if ("started_at" in fields)
            row.started_at = fields.started_at;
        if ("pid" in fields)
            row.pid = fields.pid;
        if ("exit_code" in fields)
            row.exit_code = fields.exit_code;
        if ("risk_assessment" in fields) {
            row.risk_assessment =
                fields.risk_assessment && typeof fields.risk_assessment === "object"
                    ? JSON.stringify(fields.risk_assessment)
                    : fields.risk_assessment;
        }
        if ("last_output" in fields)
            row.last_output = fields.last_output;
        if ("pr_url" in fields)
            row.pr_url = fields.pr_url;
        if ("merge_commit_sha" in fields)
            row.merge_commit_sha = fields.merge_commit_sha;
        if ("archived" in fields)
            row.archived = fields.archived ? 1 : 0;
        if ("depends_on" in fields)
            row.depends_on = JSON.stringify(fields.depends_on);
        if ("plan" in fields)
            row.plan = fields.plan;
        return row;
    }
}
//# sourceMappingURL=state.js.map