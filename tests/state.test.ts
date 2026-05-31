import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore } from "../src/state.js";
import { LoomerConfig } from "../src/config.js";
import { AgentNotFoundError } from "../src/errors.js";
import { Status } from "../src/status.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-state-"));
}

function makeConfig(stateDir: string): LoomerConfig {
  return new LoomerConfig({
    baseBranch: "",
    claudePath: "claude",
    claudeArgs: [],
    defaultPort: 3000,
    defaultTimeoutMinutes: 30,
    maxConcurrent: 5,
    stateDir: stateDir,
    skillPrefix: true,
    mergeStrategy: "auto",
    createPr: false,
    autoMergeRules: { maxFiles: 5, maxLines: 200, conflict: "review", testFail: "auto" },
  });
}

describe("StateStore", () => {
  let tmpDir: string;
  let config: LoomerConfig;
  let store: StateStore;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    config = makeConfig(tmpDir);
    store = new StateStore(config, "/fake/repo/path");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // === 基础 CRUD ===

  describe("agent CRUD", () => {
    it("getAgent 返回 null 对不存在的 agent", () => {
      expect(store.getAgent("nonexistent")).toBeNull();
    });

    it("updateAgent 创建新 agent", () => {
      store.updateAgent("test-agent", {
        status: "PENDING",
        prompt: "do something",
        branch: "feat/test",
      });
      const agent = store.getAgent("test-agent");
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe("test-agent");
      expect(agent!.status).toBe("PENDING");
      expect(agent!.prompt).toBe("do something");
    });

    it("updateAgent 合并更新字段", () => {
      store.updateAgent("test-agent", { status: "PENDING", prompt: "init" });
      store.updateAgent("test-agent", { status: "RUNNING", pid: 12345 });
      const agent = store.getAgent("test-agent");
      expect(agent!.status).toBe("RUNNING");
      expect(agent!.pid).toBe(12345);
      expect(agent!.prompt).toBe("init"); // 保留旧字段
    });

    it("updateAgentStatus 只更新状态", () => {
      store.updateAgent("test-agent", { status: "PENDING", prompt: "test" });
      store.updateAgentStatus("test-agent", Status.RUNNING);
      const agent = store.getAgent("test-agent");
      expect(agent!.status).toBe("RUNNING");
      expect(agent!.prompt).toBe("test");
    });

    it("removeAgent 删除 agent", () => {
      store.updateAgent("test-agent", { status: "PENDING" });
      store.removeAgent("test-agent");
      expect(store.getAgent("test-agent")).toBeNull();
    });

    it("removeAgent 不存在的 agent 不报错", () => {
      expect(() => store.removeAgent("nonexistent")).not.toThrow();
    });
  });

  // === 防御性字段处理 ===

  describe("防御性字段处理", () => {
    it("缺失字段提供默认值", () => {
      store.updateAgent("minimal-agent", { status: "PENDING" });
      const agent = store.getAgent("minimal-agent")!;
      expect(agent.pid).toBeNull();
      expect(agent.exit_code).toBeNull();
      expect(agent.worktree).toBeNull();
      expect(agent.started_at).toBeNull();
      expect(agent.archived).toBe(false);
      expect(agent.pr_url).toBeNull();
      expect(agent.depends_on).toEqual([]);
      expect(agent.plan).toBeNull();
    });

    it("risk_assessment 以 JSON 存储和读取", () => {
      const assessment = { level: "LOW", signals: [{ name: "test", level: "LOW", detail: "ok" }] };
      store.updateAgent("test-agent", { status: "PENDING", risk_assessment: assessment });
      const agent = store.getAgent("test-agent")!;
      expect(agent.risk_assessment).toEqual(assessment);
    });
  });

  // === 查询方法 ===

  describe("查询方法", () => {
    beforeEach(() => {
      store.updateAgent("pending-1", { status: "PENDING", depends_on: [], plan: "test-plan" });
      store.updateAgent("running-1", { status: "RUNNING", pid: 100, started_at: Date.now() / 1000 });
      store.updateAgent("done-1", { status: "DONE", exit_code: 0 });
      store.updateAgent("running-2", { status: "RUNNING", pid: 101, started_at: Date.now() / 1000 });
    });

    it("getPendingAgents 返回 PENDING agent", () => {
      const pending = store.getPendingAgents();
      expect(pending).toHaveLength(1);
      expect(pending[0].name).toBe("pending-1");
    });

    it("getRunningCount 返回 RUNNING 数量", () => {
      expect(store.getRunningCount()).toBe(2);
    });
  });

  // === Archive ===

  describe("Archive", () => {
    beforeEach(() => {
      store.updateAgent("active-agent", { status: "ACCEPTED", archived: false });
      store.updateAgent("archived-agent", { status: "DONE", archived: true });
    });

    it("archiveAgent 标记为已归档", () => {
      store.archiveAgent("active-agent");
      const agent = store.getAgent("active-agent")!;
      expect(agent.archived).toBe(true);
    });

    it("getActiveAgents 过滤已归档", () => {
      const active = store.getActiveAgents();
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("active-agent");
    });

    it("getArchivedAgents 只看已归档", () => {
      const archived = store.getArchivedAgents();
      expect(archived).toHaveLength(1);
      expect(archived[0].name).toBe("archived-agent");
    });
  });

  // === Plan CRUD ===

  describe("Plan CRUD", () => {
    it("getPlan 初始返回 null", () => {
      expect(store.getPlan()).toBeNull();
    });

    it("setPlan 和 getPlan", () => {
      const plan = {
        name: "test-plan",
        max_concurrent: 5,
        tasks: [{ id: "TS-001", prompt: "test", depends_on: [] }],
        created_at: Date.now() / 1000,
      };
      store.setPlan(plan);
      const result = store.getPlan();
      expect(result).not.toBeNull();
      expect(result!.name).toBe("test-plan");
    });

    it("clearPlan 清除计划", () => {
      store.setPlan({
        name: "test",
        max_concurrent: 5,
        tasks: [],
        created_at: Date.now() / 1000,
      });
      store.clearPlan();
      expect(store.getPlan()).toBeNull();
    });
  });

  // === 跨实例隔离 ===

  describe("跨实例隔离", () => {
    it("不同 repoPath 使用不同数据库", () => {
      const store2 = new StateStore(config, "/different/repo/path");
      store.updateAgent("agent-a", { status: "PENDING" });
      expect(store2.getAgent("agent-a")).toBeNull();
    });

    it("相同 repoPath 共享数据库", () => {
      const store2 = new StateStore(config, "/fake/repo/path");
      store.updateAgent("shared-agent", { status: "PENDING" });
      expect(store2.getAgent("shared-agent")).not.toBeNull();
    });
  });
});
