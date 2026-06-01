import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MAX_OUTPUT_CHARS } from "./config.js";
export class CliError extends Error {
    serverError;
    statusCode;
    constructor(message, serverError, statusCode) {
        super(message);
        this.name = "CliError";
        this.serverError = serverError;
        this.statusCode = statusCode ?? -1;
    }
}
export class LoomerClient {
    baseUrl;
    config;
    constructor(config) {
        this.config = config;
        this.baseUrl = `http://localhost:${config.defaultPort}`;
    }
    // --- Server detection ---
    async isServerRunning() {
        try {
            const res = await fetch(`${this.baseUrl}/api/status`, {
                signal: AbortSignal.timeout(3000),
            });
            return res.ok;
        }
        catch {
            return false;
        }
    }
    // --- Agent lifecycle (write, requires running server) ---
    async start(name, prompt) {
        return this.post("/api/start", { name, prompt });
    }
    async done(name) {
        return this.post(`/api/done/${name}`);
    }
    async kill(name, clean) {
        const qs = clean ? "?clean=1" : "";
        return this.post(`/api/kill/${name}${qs}`);
    }
    async retry(name) {
        return this.post(`/api/retry/${name}`);
    }
    async accept(name) {
        return this.post(`/api/accept/${name}`);
    }
    async reject(name) {
        return this.post(`/api/reject/${name}`);
    }
    // --- Queries (with offline fallback) ---
    async status(all) {
        if (await this.isServerRunning()) {
            const qs = all ? "?archived=true" : "";
            return this.get(`/api/status${qs}`);
        }
        return this.offlineStatus(all);
    }
    async log(name) {
        if (await this.isServerRunning()) {
            const data = await this.get(`/api/log/${name}`);
            return data.log;
        }
        return this.offlineLog(name);
    }
    // --- Plan ---
    async planStatus() {
        return this.get("/api/plan/status");
    }
    // --- HTTP helpers ---
    async get(urlPath) {
        const res = await fetch(`${this.baseUrl}${urlPath}`);
        return this.handleResponse(res);
    }
    async post(urlPath, body) {
        const init = { method: "POST" };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        const res = await fetch(`${this.baseUrl}${urlPath}`, init);
        return this.handleResponse(res);
    }
    async handleResponse(res) {
        if (!res.ok) {
            let errBody = {};
            try {
                const text = await res.text();
                errBody = JSON.parse(text);
            }
            catch {
                // JSON 解析失败，用空对象
            }
            const message = errBody.message ?? `HTTP ${res.status}`;
            throw new CliError(message, errBody.error, res.status);
        }
        return res.json();
    }
    // --- Offline SQLite fallback ---
    getDbPath() {
        const repoPath = process.cwd();
        const hash = crypto
            .createHash("sha256")
            .update(repoPath)
            .digest("hex")
            .slice(0, 12);
        return path.join(this.config.resolvedStateDir, hash, "state.db");
    }
    openDb() {
        const dbPath = this.getDbPath();
        if (!fs.existsSync(dbPath))
            return null;
        try {
            return new Database(dbPath, { readonly: true });
        }
        catch {
            return null;
        }
    }
    offlineStatus(all) {
        const db = this.openDb();
        if (!db)
            return [];
        try {
            const sql = all
                ? "SELECT * FROM agents"
                : "SELECT * FROM agents WHERE archived = 0 OR archived IS NULL";
            const rows = db.prepare(sql).all();
            return rows.map((row) => rowToAgentInfo(row));
        }
        catch {
            return [];
        }
        finally {
            db.close();
        }
    }
    offlineLog(name) {
        const db = this.openDb();
        if (!db)
            return "";
        try {
            const row = db
                .prepare("SELECT last_output FROM agents WHERE name = ?")
                .get(name);
            if (!row?.last_output)
                return "";
            const output = row.last_output;
            if (output.length > MAX_OUTPUT_CHARS) {
                return "...(truncated)\n" + output.slice(-MAX_OUTPUT_CHARS);
            }
            return output;
        }
        catch {
            return "";
        }
        finally {
            db.close();
        }
    }
}
function rowToAgentInfo(row) {
    return {
        name: String(row.name ?? ""),
        status: String(row.status ?? "UNKNOWN"),
        branch: row.branch ? String(row.branch) : undefined,
        prompt: row.prompt ? String(row.prompt) : undefined,
        worktree: row.worktree ? String(row.worktree) : undefined,
        started_at: row.started_at ? Number(row.started_at) : undefined,
        pid: row.pid != null ? Number(row.pid) : undefined,
        exit_code: row.exit_code != null ? Number(row.exit_code) : undefined,
        risk_assessment: row.risk_assessment
            ? JSON.parse(String(row.risk_assessment))
            : undefined,
        last_output: row.last_output ? String(row.last_output) : undefined,
        pr_url: row.pr_url ? String(row.pr_url) : undefined,
        archived: Boolean(row.archived),
        depends_on: row.depends_on
            ? JSON.parse(String(row.depends_on))
            : undefined,
        plan: row.plan ? String(row.plan) : undefined,
    };
}
// --- Output formatting ---
export function formatStatusTable(agents) {
    if (agents.length === 0)
        return "No agents found.";
    const nameW = Math.max(4, ...agents.map((a) => a.name.length));
    const statusW = Math.max(6, ...agents.map((a) => a.status.length));
    const branchW = Math.max(6, ...agents.map((a) => (a.branch ?? "").length));
    const promptW = 40;
    const header = [
        "NAME".padEnd(nameW),
        "STATUS".padEnd(statusW),
        "BRANCH".padEnd(branchW),
        "PROMPT",
    ].join("  ");
    const rows = agents.map((a) => {
        const prompt = (a.prompt ?? "").slice(0, promptW);
        return [
            a.name.padEnd(nameW),
            a.status.padEnd(statusW),
            (a.branch ?? "-").padEnd(branchW),
            prompt,
        ].join("  ");
    });
    return [header, ...rows].join("\n");
}
export function formatPlanStatus(progress) {
    if (!progress)
        return "No active plan.";
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return [
        `Plan: ${progress.plan} (${progress.done}/${progress.total}, ${pct}%)`,
        `  Done: ${progress.done}  Running: ${progress.running}  Pending: ${progress.pending}`,
        `  Crashed: ${progress.crashed}  Conflicted: ${progress.conflicted}  Stale: ${progress.stale}  Review: ${progress.review}`,
    ].join("\n");
}
//# sourceMappingURL=cli-client.js.map