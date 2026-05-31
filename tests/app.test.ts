import { describe, it, expect, beforeEach, vi } from "vitest";
import { execSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import type { LoomerApp } from "../src/app.js";
import type { StateStore, AgentData } from "../src/state.js";
import type { ProcessManager } from "../src/process.js";
import type { WorkspaceManager } from "../src/workspace.js";
import type { IStateStore } from "../src/status.js";
import { Status } from "../src/status.js";
import { SafetyChecks, RiskLevel } from "../src/safety.js";
import type { LoomerConfig } from "../src/config.js";
import { MergeError } from "../src/errors.js";

// === Mock 工厂 ===

function makeConfig(): LoomerConfig {
  return {
    baseBranch: "master",
    claudePath: "claude",
    claudeArgs: [],
    defaultPort: 3000,
    defaultTimeoutMinutes: 30,
    maxConcurrent: 5,
    stateDir: "/tmp/loomer-test",
    skillPrefix: true,
    mergeStrategy: "auto",
    createPr: false,
    autoMergeRules: { maxFiles: 5, maxLines: 200, conflict: "auto", testFail: "auto" },
    resolvedStateDir: "/tmp/loomer-test",
  };
}

function makeMockState(agents: Record<string, Partial<AgentData>> = {}): StateStore {
  const store = new Map<string, AgentData>();
  for (const [name, data] of Object.entries(agents)) {
    store.set(name, {
      name,
      status: data.status ?? "PENDING",
      archived: data.archived ?? false,
      pid: data.pid ?? null,
      exit_code: data.exit_code ?? null,
      started_at: data.started_at ?? null,
      worktree: data.worktree ?? null,
      prompt: data.prompt ?? null,
      branch: data.branch ?? null,
      pr_url: data.pr_url ?? null,
      risk_assessment: data.risk_assessment ?? null,
      last_output: data.last_output ?? null,
      depends_on: data.depends_on ?? [],
      plan: data.plan ?? null,
    });
  }

  return {
    getAgent: vi.fn((name: string) => store.get(name) ?? null),
    updateAgent: vi.fn((name: string, fields: Record<string, unknown>) => {
      const existing = store.get(name) ?? {
        name, status: "PENDING", archived: false, pid: null, exit_code: null,
        started_at: null, worktree: null, prompt: null, branch: null, pr_url: null,
        risk_assessment: null, last_output: null, depends_on: [], plan: null,
      };
      store.set(name, { ...existing, ...fields } as AgentData);
    }),
    updateAgentStatus: vi.fn((name: string, status: string) => {
      const existing = store.get(name);
      if (existing) store.set(name, { ...existing, status } as AgentData);
    }),
    removeAgent: vi.fn(),
    getPendingAgents: vi.fn(() => []),
    getRunningCount: vi.fn(() => 0),
    getActiveAgents: vi.fn(() => []),
    getArchivedAgents: vi.fn(() => []),
    getAllAgents: vi.fn(() => Array.from(store.values())),
    archiveAgent: vi.fn(),
    getPlan: vi.fn(() => null),
    setPlan: vi.fn(),
    clearPlan: vi.fn(),
  } as unknown as StateStore;
}

function makeMockProcess(): ProcessManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isAlive: vi.fn(() => false),
    getPid: vi.fn(() => null),
    getRecentOutput: vi.fn(() => ""),
    hasExited: vi.fn(() => false),
    getExitCode: vi.fn(() => null),
    listProcesses: vi.fn(() => []),
  } as unknown as ProcessManager;
}

function makeMockWorkspace(): WorkspaceManager {
  return {
    create: vi.fn((_name: string, _baseBranch?: string) => ({
      name: _name,
      path: `/worktree/${_name}`,
      branch: _name,
    })),
    remove: vi.fn(),
    listAll: vi.fn(() => []),
    exists: vi.fn(() => false),
  } as unknown as WorkspaceManager;
}

function makeMockIStateStore(): IStateStore {
  return {
    getAgent: vi.fn(() => null),
    updateAgentStatus: vi.fn(),
  };
}

function makeApp(
  LoomerAppClass: typeof import("../src/app.js").LoomerApp,
  config: LoomerConfig,
  state: StateStore,
  processManager: ProcessManager,
  workspaceManager: WorkspaceManager,
): LoomerApp {
  return new LoomerAppClass(
    config, state, processManager, workspaceManager, makeMockIStateStore(),
  );
}

// === 测试 ===

describe("LoomerApp", () => {
  let config: LoomerConfig;
  let state: StateStore;
  let processManager: ProcessManager;
  let workspaceManager: WorkspaceManager;
  let app: LoomerApp;
  let LoomerAppClass: typeof import("../src/app.js").LoomerApp;

  beforeEach(async () => {
    config = makeConfig();
    state = makeMockState();
    processManager = makeMockProcess();
    workspaceManager = makeMockWorkspace();
    vi.mocked(execSync).mockReset();

    const mod = await import("../src/app.js");
    LoomerAppClass = mod.LoomerApp;

    app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);
  });

  // === start ===

  describe("start", () => {
    it("创建 worktree 并启动 agent 进程", () => {
      app.start("test-agent", "do something");
      expect(workspaceManager.create).toHaveBeenCalledWith("test-agent", "master");
      expect(processManager.start).toHaveBeenCalledWith("test-agent", "/worktree/test-agent", "do something");
      expect(state.updateAgent).toHaveBeenCalledWith("test-agent", expect.objectContaining({
        status: "RUNNING",
        worktree: "/worktree/test-agent",
        prompt: "do something",
      }));
    });
  });

  // === done — 风险门禁核心 ===

  describe("done", () => {
    beforeEach(() => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git diff --cached --quiet") throw new Error("has changes");
        return "";
      });
    });

    it("auto + LOW → ACCEPTED + 清理 worktree", () => {
      state = makeMockState({
        "test-agent": { status: "DONE", worktree: "/worktree/test-agent", prompt: "test" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      vi.spyOn(SafetyChecks.prototype, "assessRisk").mockReturnValue({
        level: RiskLevel.LOW,
        signals: [],
        toDict: () => ({ level: "LOW", signals: [] }),
      } as never);

      app.done("test-agent");

      expect(state.updateAgentStatus).toHaveBeenCalledWith("test-agent", "ACCEPTED");
      expect(workspaceManager.remove).toHaveBeenCalledWith("test-agent");
    });

    it("auto + HIGH → REVIEW + 保留 worktree", () => {
      state = makeMockState({
        "test-agent": { status: "DONE", worktree: "/worktree/test-agent", prompt: "test" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      vi.spyOn(SafetyChecks.prototype, "assessRisk").mockReturnValue({
        level: RiskLevel.HIGH,
        signals: [],
        toDict: () => ({ level: "HIGH", signals: [] }),
      } as never);

      app.done("test-agent");

      expect(state.updateAgentStatus).toHaveBeenCalledWith("test-agent", "REVIEW");
      expect(workspaceManager.remove).not.toHaveBeenCalled();
    });

    it("never → ACCEPTED", () => {
      const neverConfig = { ...config, mergeStrategy: "never" as const };
      state = makeMockState({
        "test-agent": { status: "DONE", worktree: "/worktree/test-agent", prompt: "test" },
      });
      app = makeApp(LoomerAppClass, neverConfig, state, processManager, workspaceManager);

      app.done("test-agent");

      expect(state.updateAgentStatus).toHaveBeenCalledWith("test-agent", "ACCEPTED");
    });

    it("always → REVIEW", () => {
      const alwaysConfig = { ...config, mergeStrategy: "always" as const };
      state = makeMockState({
        "test-agent": { status: "DONE", worktree: "/worktree/test-agent", prompt: "test" },
      });
      app = makeApp(LoomerAppClass, alwaysConfig, state, processManager, workspaceManager);

      app.done("test-agent");

      expect(state.updateAgentStatus).toHaveBeenCalledWith("test-agent", "REVIEW");
    });

    it("CONFLICTED → 保留 worktree 供人工处理", () => {
      state = makeMockState({
        "test-agent": { status: "DONE", worktree: "/worktree/test-agent", prompt: "test" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      // mock _mergeAgent 抛 MergeError
      vi.spyOn(app, "_mergeAgent" as never).mockImplementation(() => {
        throw new MergeError("merge conflict", ["a.ts"]);
      });

      app.done("test-agent");

      expect(state.updateAgentStatus).toHaveBeenCalledWith("test-agent", "CONFLICTED");
    });
  });

  // === accept / reject ===

  describe("accept", () => {
    it("REVIEW → ACCEPTED + 清理 worktree", () => {
      state = makeMockState({
        "test-agent": { status: "REVIEW", worktree: "/worktree/test-agent" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      app.accept("test-agent");

      expect(state.updateAgentStatus).toHaveBeenCalledWith("test-agent", "ACCEPTED");
      expect(workspaceManager.remove).toHaveBeenCalledWith("test-agent");
    });
  });

  describe("reject", () => {
    it("REVIEW → REJECTED + 清理 worktree", () => {
      state = makeMockState({
        "test-agent": { status: "REVIEW", worktree: "/worktree/test-agent" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      app.reject("test-agent");

      expect(state.updateAgentStatus).toHaveBeenCalledWith("test-agent", "REJECTED");
      expect(workspaceManager.remove).toHaveBeenCalledWith("test-agent");
    });
  });

  // === kill / retry ===

  describe("kill", () => {
    it("停止进程 + 更新状态", () => {
      state = makeMockState({
        "test-agent": { status: "RUNNING", worktree: "/worktree/test-agent" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      app.kill("test-agent");

      expect(processManager.stop).toHaveBeenCalledWith("test-agent");
    });
  });

  describe("retry", () => {
    it("重新启动 agent", () => {
      state = makeMockState({
        "test-agent": { status: "CRASHED", worktree: "/worktree/test-agent", prompt: "test" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      app.retry("test-agent");

      expect(processManager.start).toHaveBeenCalled();
    });
  });

  // === status / log ===

  describe("status", () => {
    it("返回所有活跃 agent", () => {
      state = makeMockState({
        "agent-1": { status: "RUNNING" },
        "agent-2": { status: "DONE", archived: true },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      const result = app.status();
      expect(result).toHaveLength(2);
    });
  });

  describe("log", () => {
    it("返回 agent 日志", () => {
      processManager = {
        ...makeMockProcess(),
        getRecentOutput: vi.fn(() => "log line 1\nlog line 2"),
      } as unknown as ProcessManager;
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      const result = app.log("test-agent");
      expect(result).toBe("log line 1\nlog line 2");
    });
  });

  // === transition callback 自动触发 done ===

  describe("auto-done via transition callback", () => {
    it("StatusDetector transition callback 触发 done()", () => {
      state = makeMockState({
        "test-agent": { status: "RUNNING", worktree: "/worktree/test-agent", prompt: "test" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      const doneSpy = vi.spyOn(app, "done").mockImplementation(() => {});

      app.onTransition("test-agent", Status.DONE);

      expect(doneSpy).toHaveBeenCalledWith("test-agent");
    });

    it("非 DONE 状态不触发 done", () => {
      state = makeMockState({
        "test-agent": { status: "RUNNING", worktree: "/worktree/test-agent" },
      });
      app = makeApp(LoomerAppClass, config, state, processManager, workspaceManager);

      const doneSpy = vi.spyOn(app, "done").mockImplementation(() => {});

      app.onTransition("test-agent", Status.CRASHED);
      app.onTransition("test-agent", Status.STALE);

      expect(doneSpy).not.toHaveBeenCalled();
    });
  });
});
