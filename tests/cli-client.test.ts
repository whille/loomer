import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { LoomerClient, CliError, formatStatusTable, formatPlanStatus } from "../src/cli-client.js";
import { LoomerConfig } from "../src/config.js";
import type { AgentInfo, PlanProgress } from "../src/types/web.js";

// 辅助：创建测试用 LoomerConfig
function makeTestConfig(overrides?: { port?: number; stateDir?: string }): LoomerConfig {
  return new LoomerConfig({
    baseBranch: "main",
    claudePath: "claude",
    claudeArgs: [],
    defaultPort: overrides?.port ?? 3000,
    defaultTimeoutMinutes: 30,
    maxConcurrent: 5,
    stateDir: overrides?.stateDir ?? os.tmpdir(),
    skillPrefix: true,
    mergeStrategy: "auto",
    createPr: false,
    autoMergeRules: {
      maxFiles: 5,
      maxLines: 200,
      conflict: "review",
      testFail: "auto",
    },
  });
}

// 辅助：创建临时 SQLite 数据库
function createTestDb(dir: string): Database.Database {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "state.db");
  const db = new Database(dbPath);

  db.exec(`
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
    )
  `);

  return db;
}

describe("CliError", () => {
  it("carries serverError and statusCode", () => {
    const err = new CliError("not found", "AgentNotFoundError", 400);
    expect(err.message).toBe("not found");
    expect(err.serverError).toBe("AgentNotFoundError");
    expect(err.statusCode).toBe(400);
  });

  it("defaults statusCode to -1", () => {
    const err = new CliError("connection failed");
    expect(err.statusCode).toBe(-1);
    expect(err.serverError).toBeUndefined();
  });
});

describe("LoomerClient", () => {
  let client: LoomerClient;
  let config: LoomerConfig;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    config = makeTestConfig();
    client = new LoomerClient(config);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // --- Server detection ---

  describe("isServerRunning", () => {
    it("returns true when server responds OK", async () => {
      fetchSpy.mockResolvedValue(new Response("[]", { status: 200 }));
      expect(await client.isServerRunning()).toBe(true);
    });

    it("returns false on fetch rejection (ECONNREFUSED)", async () => {
      fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
      expect(await client.isServerRunning()).toBe(false);
    });
  });

  // --- Write operations ---

  describe("start", () => {
    it("sends POST /api/start with name and prompt", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await client.start("my-agent", "do stuff");
      expect(result).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3000/api/start",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "my-agent", prompt: "do stuff" }),
        }),
      );
    });

    it("throws CliError on server error", async () => {
      // 每次调用需要新建 Response（body 只能消费一次）
      fetchSpy.mockImplementation(async () =>
        new Response(
          JSON.stringify({ error: "InvalidNameError", message: "bad name" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      );
      await expect(client.start("bad!", "prompt")).rejects.toThrow(CliError);
      await expect(client.start("bad!", "prompt")).rejects.toThrow("bad name");
    });
  });

  describe("done", () => {
    it("sends POST /api/done/:name", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await client.done("my-agent");
      expect(result).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3000/api/done/my-agent",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("kill", () => {
    it("sends POST /api/kill/:name without clean", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await client.kill("my-agent");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3000/api/kill/my-agent",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("sends POST /api/kill/:name?clean=1 with clean flag", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await client.kill("my-agent", true);
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3000/api/kill/my-agent?clean=1",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("retry", () => {
    it("sends POST /api/retry/:name", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await client.retry("my-agent");
      expect(result).toEqual({ ok: true });
    });
  });

  describe("accept", () => {
    it("sends POST /api/accept/:name", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await client.accept("my-agent");
      expect(result).toEqual({ ok: true });
    });
  });

  describe("reject", () => {
    it("sends POST /api/reject/:name", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await client.reject("my-agent");
      expect(result).toEqual({ ok: true });
    });
  });

  // --- Query operations ---

  describe("status (HTTP)", () => {
    it("fetches from /api/status when server is running", async () => {
      const agents: AgentInfo[] = [
        { name: "a1", status: "RUNNING", archived: false },
      ];
      // isServerRunning call
      fetchSpy.mockResolvedValueOnce(
        new Response("[]", { status: 200 }),
      );
      // actual status call
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(agents), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.status();
      expect(result).toEqual(agents);
    });

    it("fetches with ?archived=true when all is true", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("[]", { status: 200 }));
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await client.status(true);
      // 第二次 fetch 调用应包含 archived=true
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "http://localhost:3000/api/status?archived=true",
      );
    });
  });

  describe("log (HTTP)", () => {
    it("fetches from /api/log/:name when server is running", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("[]", { status: 200 }));
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ log: "line1\nline2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.log("my-agent");
      expect(result).toBe("line1\nline2");
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "http://localhost:3000/api/log/my-agent",
      );
    });
  });

  describe("planStatus", () => {
    it("fetches from /api/plan/status", async () => {
      const progress: PlanProgress = {
        plan: "test-plan",
        total: 3,
        done: 1,
        running: 1,
        pending: 1,
        crashed: 0,
        conflicted: 0,
        stale: 0,
        review: 0,
      };
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify(progress), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.planStatus();
      expect(result).toEqual(progress);
    });
  });
});

// 检测 better-sqlite3 原生绑定是否可用
let sqliteAvailable = false;
try {
  new Database(":memory:");
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

describe("LoomerClient offline fallback", () => {
  let tmpDir: string;
  let config: LoomerConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loomer-test-"));
    config = makeTestConfig({ stateDir: tmpDir });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("status offline", () => {
    const skipNoNative = it.skipIf(!sqliteAvailable);

    skipNoNative("reads agents from SQLite when server is down", async () => {
      // 构造正确的 DB 路径（sha256(cwd)[:12]）
      const crypto = await import("node:crypto");
      const hash = crypto
        .createHash("sha256")
        .update(process.cwd())
        .digest("hex")
        .slice(0, 12);
      const dbDir = path.join(tmpDir, hash);
      const db = createTestDb(dbDir);

      db.prepare(
        "INSERT INTO agents (name, status, prompt, archived) VALUES (?, ?, ?, ?)",
      ).run("agent-1", "RUNNING", "do stuff", 0);
      db.prepare(
        "INSERT INTO agents (name, status, prompt, archived) VALUES (?, ?, ?, ?)",
      ).run("agent-2", "DONE", "old task", 1);
      db.close();

      const client = new LoomerClient(config);
      const agents = await client.status();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("agent-1");
    });

    skipNoNative("includes archived agents with all=true", async () => {
      const crypto = await import("node:crypto");
      const hash = crypto
        .createHash("sha256")
        .update(process.cwd())
        .digest("hex")
        .slice(0, 12);
      const dbDir = path.join(tmpDir, hash);
      const db = createTestDb(dbDir);

      db.prepare(
        "INSERT INTO agents (name, status, prompt, archived) VALUES (?, ?, ?, ?)",
      ).run("agent-1", "RUNNING", "do stuff", 0);
      db.prepare(
        "INSERT INTO agents (name, status, prompt, archived) VALUES (?, ?, ?, ?)",
      ).run("agent-2", "DONE", "old task", 1);
      db.close();

      const client = new LoomerClient(config);
      const agents = await client.status(true);
      expect(agents).toHaveLength(2);
    });

    it("returns empty array when DB does not exist", async () => {
      const client = new LoomerClient(config);
      const agents = await client.status();
      expect(agents).toEqual([]);
    });
  });

  describe("log offline", () => {
    const skipNoNative = it.skipIf(!sqliteAvailable);

    skipNoNative("reads last_output from SQLite when server is down", async () => {
      const crypto = await import("node:crypto");
      const hash = crypto
        .createHash("sha256")
        .update(process.cwd())
        .digest("hex")
        .slice(0, 12);
      const dbDir = path.join(tmpDir, hash);
      const db = createTestDb(dbDir);

      const output = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
      db.prepare(
        "INSERT INTO agents (name, status, last_output, archived) VALUES (?, ?, ?, ?)",
      ).run("my-agent", "DONE", output, 0);
      db.close();

      const client = new LoomerClient(config);
      const log = await client.log("my-agent");
      expect(log).toContain("line 1");
    });

    skipNoNative("returns empty string when agent not found", async () => {
      const crypto = await import("node:crypto");
      const hash = crypto
        .createHash("sha256")
        .update(process.cwd())
        .digest("hex")
        .slice(0, 12);
      const dbDir = path.join(tmpDir, hash);
      const db = createTestDb(dbDir);
      db.close();

      const client = new LoomerClient(config);
      const log = await client.log("nonexistent");
      expect(log).toBe("");
    });

    it("returns empty string when DB does not exist", async () => {
      const client = new LoomerClient(config);
      const log = await client.log("any-agent");
      expect(log).toBe("");
    });
  });
});

describe("formatStatusTable", () => {
  it("shows 'No agents found.' for empty list", () => {
    expect(formatStatusTable([])).toBe("No agents found.");
  });

  it("formats agent list as aligned table", () => {
    const agents: AgentInfo[] = [
      { name: "auth", status: "RUNNING", branch: "lm-auth", prompt: "Add auth", archived: false },
      { name: "fix-bug", status: "DONE", prompt: "Fix bug", archived: true },
    ];
    const table = formatStatusTable(agents);
    expect(table).toContain("NAME");
    expect(table).toContain("STATUS");
    expect(table).toContain("auth");
    expect(table).toContain("RUNNING");
    expect(table).toContain("fix-bug");
    expect(table).toContain("DONE");
  });
});

describe("formatPlanStatus", () => {
  it("shows 'No active plan.' for null", () => {
    expect(formatPlanStatus(null)).toBe("No active plan.");
  });

  it("formats progress with percentage", () => {
    const progress: PlanProgress = {
      plan: "feature-auth",
      total: 5,
      done: 2,
      running: 1,
      pending: 1,
      crashed: 0,
      conflicted: 0,
      stale: 0,
      review: 1,
    };
    const result = formatPlanStatus(progress);
    expect(result).toContain("feature-auth");
    expect(result).toContain("2/5");
    expect(result).toContain("40%");
    expect(result).toContain("Done: 2");
    expect(result).toContain("Running: 1");
  });
});
