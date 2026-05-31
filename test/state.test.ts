import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore, type Agent, type PlanData, type State } from "../src/state.js";
import { AgentNotFoundError } from "../src/errors.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-state-test-"));
}

describe("StateStore", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new StateStore({ stateDir: dir } as any, "/fake/repo/path");
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // === 构造 & Schema ===

  it("creates DB file with repo-path isolation (SHA256[:12])", () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[0-9a-f]{12}\.db$/);
  });

  it("enables WAL mode and busy_timeout", () => {
    const journalMode = store.db.pragma("journal_mode", { simple: true });
    expect(journalMode).toBe("wal");
    const busyTimeout = store.db.pragma("busy_timeout", { simple: true });
    expect(busyTimeout).toBe(5000);
  });

  it("different repoPaths produce different DB files", () => {
    const store2 = new StateStore({ stateDir: dir } as any, "/other/repo");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
    expect(files.length).toBe(2);
    store2.close();
  });

  // === load / save ===

  it("load() returns empty state initially", () => {
    const state = store.load();
    expect(state.agents).toEqual([]);
    expect(state.plan).toBeNull();
  });

  it("save() + load() round-trips state", () => {
    const agent: Agent = {
      name: "LMR-001",
      status: "PENDING",
      branch: "feat/lmr-001",
      prompt: "implement X",
      worktree: "/tmp/wt-lmr-001",
      started_at: 1000,
      pid: 42,
      exit_code: null,
      risk_assessment: { level: "LOW", signals: [] },
      last_output: "hello",
      pr_url: null,
      archived: false,
      depends_on: [],
      plan: null,
    };
    const plan: PlanData = {
      name: "test-plan",
      max_concurrent: 3,
      tasks: [
        { id: "LMR-001", prompt: "do X", dependsOn: [] },
      ],
      created_at: 2000,
    };
    store.save({ agents: [agent], plan });

    const loaded = store.load();
    expect(loaded.agents.length).toBe(1);
    expect(loaded.agents[0].name).toBe("LMR-001");
    expect(loaded.agents[0].risk_assessment).toEqual({ level: "LOW", signals: [] });
    expect(loaded.plan).not.toBeNull();
    expect(loaded.plan!.name).toBe("test-plan");
  });

  // === updateAgent / updateAgentStatus ===

  it("updateAgent creates agent if not exists", () => {
    store.updateAgent("LMR-001", { prompt: "hello", status: "PENDING" });
    const agent = store.getAgent("LMR-001");
    expect(agent).not.toBeNull();
    expect(agent!.prompt).toBe("hello");
    expect(agent!.status).toBe("PENDING");
  });

  it("updateAgent merges fields on existing agent (upsert)", () => {
    store.updateAgent("LMR-001", { prompt: "hello", status: "PENDING" });
    store.updateAgent("LMR-001", { pid: 99, status: "RUNNING" });
    const agent = store.getAgent("LMR-001");
    expect(agent!.prompt).toBe("hello"); // 保留旧字段
    expect(agent!.pid).toBe(99); // 新字段
    expect(agent!.status).toBe("RUNNING"); // 覆盖
  });

  it("updateAgent throws on name mismatch", () => {
    expect(() =>
      store.updateAgent("LMR-001", { name: "LMR-002", status: "PENDING" })
    ).toThrow(/name mismatch/);
  });

  it("updateAgentStatus changes only status", () => {
    store.updateAgent("LMR-001", { prompt: "hello", status: "PENDING" });
    store.updateAgentStatus("LMR-001", "RUNNING" as any);
    const agent = store.getAgent("LMR-001");
    expect(agent!.status).toBe("RUNNING");
    expect(agent!.prompt).toBe("hello"); // 其他字段不变
  });

  it("updateAgentStatus throws on missing agent", () => {
    expect(() => store.updateAgentStatus("no-such", "RUNNING" as any)).toThrow(
      AgentNotFoundError,
    );
  });

  // === removeAgent ===

  it("removeAgent deletes agent from store", () => {
    store.updateAgent("LMR-001", { status: "PENDING" });
    store.removeAgent("LMR-001");
    expect(store.getAgent("LMR-001")).toBeNull();
  });

  it("removeAgent on missing agent is no-op", () => {
    expect(() => store.removeAgent("no-such")).not.toThrow();
  });

  // === getAgent 防御性处理 ===

  it("getAgent returns null for missing agent", () => {
    expect(store.getAgent("no-such")).toBeNull();
  });

  it("getAgent fills defaults for missing nullable fields", () => {
    // 直接用 SQL 插入最小行（模拟旧数据/迁移场景）
    store.db
      .prepare(
        `INSERT INTO agents (name, status) VALUES ('minimal', 'PENDING')`,
      )
      .run();

    const agent = store.getAgent("minimal")!;
    expect(agent.name).toBe("minimal");
    expect(agent.branch).toBeNull();
    expect(agent.prompt).toBeNull();
    expect(agent.worktree).toBeNull();
    expect(agent.started_at).toBeNull();
    expect(agent.pid).toBeNull();
    expect(agent.exit_code).toBeNull();
    expect(agent.risk_assessment).toBeNull();
    expect(agent.last_output).toBeNull();
    expect(agent.pr_url).toBeNull();
    expect(agent.archived).toBe(false);
    expect(agent.depends_on).toEqual([]);
    expect(agent.plan).toBeNull();
  });

  // === Plan CRUD ===

  it("getPlan returns null initially", () => {
    expect(store.getPlan()).toBeNull();
  });

  it("setPlan + getPlan round-trips", () => {
    const plan: PlanData = {
      name: "my-plan",
      max_concurrent: 5,
      tasks: [
        { id: "T1", prompt: "p1", dependsOn: [] },
        { id: "T2", prompt: "p2", dependsOn: ["T1"] },
      ],
      created_at: 3000,
    };
    store.setPlan(plan);
    const loaded = store.getPlan()!;
    expect(loaded.name).toBe("my-plan");
    expect(loaded.tasks.length).toBe(2);
    expect(loaded.tasks[1].dependsOn).toEqual(["T1"]);
  });

  it("setPlan overwrites existing plan", () => {
    store.setPlan({ name: "old", max_concurrent: 1, tasks: [], created_at: 1 });
    store.setPlan({ name: "new", max_concurrent: 2, tasks: [], created_at: 2 });
    expect(store.getPlan()!.name).toBe("new");
  });

  it("clearPlan removes plan", () => {
    store.setPlan({ name: "x", max_concurrent: 1, tasks: [], created_at: 1 });
    store.clearPlan();
    expect(store.getPlan()).toBeNull();
  });

  // === getPendingAgents / getRunningCount ===

  it("getPendingAgents returns only PENDING agents", () => {
    store.updateAgent("A", { status: "PENDING" });
    store.updateAgent("B", { status: "RUNNING" });
    store.updateAgent("C", { status: "PENDING" });
    const pending = store.getPendingAgents();
    expect(pending.map((a) => a.name).sort()).toEqual(["A", "C"]);
  });

  it("getPendingAgents excludes archived", () => {
    store.updateAgent("A", { status: "PENDING" });
    store.updateAgent("B", { status: "PENDING" });
    store.archiveAgent("B");
    const pending = store.getPendingAgents();
    expect(pending.map((a) => a.name)).toEqual(["A"]);
  });

  it("getRunningCount counts non-archived RUNNING agents", () => {
    store.updateAgent("A", { status: "RUNNING" });
    store.updateAgent("B", { status: "RUNNING" });
    store.updateAgent("C", { status: "PENDING" });
    store.updateAgent("D", { status: "RUNNING", archived: 1 });
    expect(store.getRunningCount()).toBe(2);
  });

  // === Archive ===

  it("archiveAgent marks agent as archived", () => {
    store.updateAgent("A", { status: "DONE" });
    store.archiveAgent("A");
    expect(store.getAgent("A")!.archived).toBe(true);
  });

  it("archiveAgent throws on missing agent", () => {
    expect(() => store.archiveAgent("no-such")).toThrow(AgentNotFoundError);
  });

  it("getActiveAgents excludes archived", () => {
    store.updateAgent("A", { status: "RUNNING" });
    store.updateAgent("B", { status: "DONE" });
    store.archiveAgent("B");
    const active = store.getActiveAgents();
    expect(active.map((a) => a.name)).toEqual(["A"]);
  });

  it("getArchivedAgents returns only archived", () => {
    store.updateAgent("A", { status: "DONE" });
    store.updateAgent("B", { status: "DONE" });
    store.archiveAgent("B");
    const archived = store.getArchivedAgents();
    expect(archived.map((a) => a.name)).toEqual(["B"]);
  });

  // === JSON 字段序列化 ===

  it("round-trips risk_assessment as JSON object", () => {
    const ra = { level: "HIGH", signals: [{ name: "big-diff", detail: "500 lines" }] };
    store.updateAgent("A", { status: "PENDING", risk_assessment: JSON.stringify(ra) });
    const agent = store.getAgent("A")!;
    expect(agent.risk_assessment).toEqual(ra);
  });

  it("round-trips depends_on as JSON array", () => {
    store.updateAgent("A", { status: "PENDING", depends_on: JSON.stringify(["B", "C"]) });
    const agent = store.getAgent("A")!;
    expect(agent.depends_on).toEqual(["B", "C"]);
  });

  // === close 幂等 ===

  it("close() is idempotent", () => {
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
