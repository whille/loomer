import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { AgentNotFoundError } from "../src/errors.js";
import {
  type IAgentData,
  type IProcessManager,
  type IStateStore,
  Status,
  StatusDetector,
} from "../src/status.js";

// --- Mock 工厂 ---

function createAgent(overrides: Partial<IAgentData> = {}): IAgentData {
  return {
    name: "test-agent",
    status: Status.RUNNING,
    pid: null,
    started_at: Date.now() / 1000 - 60,
    exit_code: null,
    worktree: null,
    ...overrides,
  };
}

function createMockState(agents: Record<string, IAgentData> = {}): IStateStore {
  return {
    getAgent: vi.fn((name: string) => agents[name] ?? null),
    updateAgentStatus: vi.fn(),
  };
}

function createMockProcess(
  overrides: Partial<IProcessManager> = {},
): IProcessManager {
  const base = {
    isAlive: vi.fn(() => false),
    getPid: vi.fn(() => null),
    getRecentOutput: vi.fn(() => ""),
    hasExited: vi.fn(() => false),
    getExitCode: vi.fn(() => null),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: mock factory needs any cast
      base[key as keyof IProcessManager] = vi.fn(value as any) as any;
    }
  }
  return base;
}

// --- 测试 ---

describe("StatusDetector", () => {
  let state: IStateStore;
  let proc: IProcessManager;
  let detector: StatusDetector;

  beforeEach(() => {
    state = createMockState();
    proc = createMockProcess();
    detector = new StatusDetector(state, proc, 30);
  });

  // === Step 1: 终态直返 ===

  describe("getStatus() - 终态直返", () => {
    for (const terminalStatus of [
      Status.CRASHED,
      Status.CONFLICTED,
      Status.STALE,
      Status.REVIEW,
      Status.ACCEPTED,
      Status.REJECTED,
    ]) {
      it(`${terminalStatus} 直返，不做检测`, () => {
        const agent = createAgent({ status: terminalStatus });
        state = createMockState({ "test-agent": agent });
        detector = new StatusDetector(state, proc, 30);

        expect(detector.getStatus("test-agent")).toBe(terminalStatus);
        expect(proc.isAlive).not.toHaveBeenCalled();
      });
    }
  });

  describe("getStatus() - PENDING", () => {
    it("PENDING 直返，不做检测", () => {
      const agent = createAgent({ status: Status.PENDING });
      state = createMockState({ "test-agent": agent });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.PENDING);
      expect(proc.isAlive).not.toHaveBeenCalled();
    });
  });

  describe("getStatus() - DONE 直返", () => {
    it("DONE 直返，不做检测（设计不变量 Step 1）", () => {
      const agent = createAgent({ status: Status.DONE });
      state = createMockState({ "test-agent": agent });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.DONE);
      expect(proc.isAlive).not.toHaveBeenCalled();
      expect(state.updateAgentStatus).not.toHaveBeenCalled();
    });
  });

  // === Step 2: STALE 超时 ===

  describe("getStatus() - step 2: STALE 超时", () => {
    it("started_at + timeout 超时 → STALE", () => {
      const agent = createAgent({
        started_at: Date.now() / 1000 - 31 * 60,
      });
      state = createMockState({ "test-agent": agent });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.STALE);
      expect(state.updateAgentStatus).toHaveBeenCalledWith(
        "test-agent",
        Status.STALE,
      );
    });

    it("started_at = 0（缺字段）→ 不误判 STALE", () => {
      const agent = createAgent({ started_at: 0 });
      state = createMockState({ "test-agent": agent });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).not.toBe(Status.STALE);
    });

    it("在超时时间内 → 不是 STALE", () => {
      const agent = createAgent({
        started_at: Date.now() / 1000 - 10 * 60,
      });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => true });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.RUNNING);
    });
  });

  // === Step 3: 同实例 isAlive ===

  describe("getStatus() - step 3: 同实例 isAlive", () => {
    it("isAlive() = true → 仍为 RUNNING", () => {
      const agent = createAgent();
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => true });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.RUNNING);
    });

    it("isAlive 为 true 时不查 PID", () => {
      const agent = createAgent({ pid: 12345 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => true, getPid: () => 12345 });
      detector = new StatusDetector(state, proc, 30);

      detector.getStatus("test-agent");
      expect(proc.getPid).not.toHaveBeenCalled();
    });
  });

  // === Step 4: 跨实例 PID ===

  describe("getStatus() - step 4: 跨实例 PID", () => {
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      killSpy = vi.spyOn(globalThis.process, "kill");
    });

    afterEach(() => {
      killSpy.mockRestore();
    });

    it("PID 存活 → 仍为 RUNNING", () => {
      const agent = createAgent({ pid: 12345 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);
      killSpy.mockReturnValue(true);

      expect(detector.getStatus("test-agent")).toBe(Status.RUNNING);
    });

    it("agent.pid 优先于 proc.getPid()", () => {
      const agent = createAgent({ pid: 11111 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false, getPid: () => 22222 });
      detector = new StatusDetector(state, proc, 30);
      killSpy.mockReturnValue(true);

      detector.getStatus("test-agent");
      expect(killSpy).toHaveBeenCalledWith(11111, 0);
    });

    it("pid = null → 跳过 PID 检测", () => {
      const agent = createAgent({ pid: null });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false, getPid: () => null });
      detector = new StatusDetector(state, proc, 30);
      killSpy.mockReturnValue(false);

      expect(detector.getStatus("test-agent")).not.toBe(Status.RUNNING);
    });
  });

  // === Step 5: exit_code 持久化值 ===

  describe("getStatus() - step 5: exit_code 持久化值", () => {
    it("exit_code = 0 → DONE", () => {
      const agent = createAgent({ exit_code: 0 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.DONE);
      expect(state.updateAgentStatus).toHaveBeenCalledWith(
        "test-agent",
        Status.DONE,
      );
    });

    it("exit_code ≠ 0 → CRASHED（short-circuit）", () => {
      const agent = createAgent({ exit_code: 1 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        getRecentOutput: () => "some output content",
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.CRASHED);
    });

    it("exit_code=1 不会 fallthrough 到日志启发式", () => {
      const agent = createAgent({ exit_code: 1 });
      state = createMockState({ "test-agent": agent });
      const mockProc = createMockProcess({
        isAlive: () => false,
        getRecentOutput: () => "plenty of output here",
        hasExited: () => true,
        getExitCode: () => 0,
      });
      detector = new StatusDetector(state, mockProc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.CRASHED);
    });
  });

  // === Step 6: 内存 spawn exit 事件 ===

  describe("getStatus() - step 6: 内存 spawn exit 事件", () => {
    it("hasExited=true + getExitCode=0 → DONE", () => {
      const agent = createAgent({ exit_code: null });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        hasExited: () => true,
        getExitCode: () => 0,
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.DONE);
    });

    it("hasExited=true + getExitCode≠0 → CRASHED", () => {
      const agent = createAgent({ exit_code: null });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        hasExited: () => true,
        getExitCode: () => 137,
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.CRASHED);
    });
  });

  // === Step 7: 日志启发式 ===

  describe("getStatus() - step 7: 日志启发式", () => {
    it("输出非空 + 进程已退出 → DONE", () => {
      const agent = createAgent({ exit_code: null });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        hasExited: () => false,
        getRecentOutput: () => "some log content",
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.DONE);
    });

    it("输出为空 → 不匹配此步", () => {
      const agent = createAgent({ exit_code: null, worktree: null });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        hasExited: () => false,
        getRecentOutput: () => "",
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.CRASHED);
    });
  });

  // === Step 8: worktree 未提交变更 ===

  describe("getStatus() - step 8: worktree 未提交变更", () => {
    it("worktree 有未提交变更 → auto-commit + DONE", () => {
      const agent = createAgent({
        exit_code: null,
        worktree: "/fake/worktree",
      });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        hasExited: () => false,
        getRecentOutput: () => "",
      });
      detector = new StatusDetector(state, proc, 30);

      vi.mocked(childProcess.execSync).mockImplementation((cmd: string) => {
        if (cmd === "git status --porcelain") return "M file.ts\n";
        if (cmd === "git add -A") return "";
        if (cmd.includes("git diff --cached --quiet"))
          throw new Error("has changes");
        if (cmd.includes("git commit")) return "";
        return "";
      });

      expect(detector.getStatus("test-agent")).toBe(Status.DONE);
      expect(state.updateAgentStatus).toHaveBeenCalledWith(
        "test-agent",
        Status.DONE,
      );
      vi.mocked(childProcess.execSync).mockRestore();
    });

    it("auto-commit 失败仍返回 DONE", () => {
      const agent = createAgent({
        exit_code: null,
        worktree: "/fake/worktree",
      });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        hasExited: () => false,
        getRecentOutput: () => "",
      });
      detector = new StatusDetector(state, proc, 30);

      vi.mocked(childProcess.execSync).mockImplementation((cmd: string) => {
        if (cmd === "git status --porcelain") return "M file.ts\n";
        throw new Error("git failed");
      });

      expect(detector.getStatus("test-agent")).toBe(Status.DONE);
      vi.mocked(childProcess.execSync).mockRestore();
    });

    it("worktree = null → 跳过 step 8", () => {
      const agent = createAgent({
        exit_code: null,
        worktree: null,
        started_at: 0,
      });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        hasExited: () => false,
        getRecentOutput: () => "",
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.CRASHED);
    });
  });

  // === Step 9: 兜底 ===

  describe("getStatus() - step 9: 兜底 CRASHED", () => {
    it("无任何匹配 → CRASHED", () => {
      const agent = createAgent({
        exit_code: null,
        pid: null,
        worktree: null,
        started_at: 0,
      });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        getPid: () => null,
        hasExited: () => false,
        getRecentOutput: () => "",
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.CRASHED);
      expect(state.updateAgentStatus).toHaveBeenCalledWith(
        "test-agent",
        Status.CRASHED,
      );
    });
  });

  // === 优先级顺序测试 ===

  describe("getStatus() - 优先级顺序", () => {
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      killSpy = vi.spyOn(globalThis.process, "kill");
    });

    afterEach(() => {
      killSpy.mockRestore();
    });

    it("STALE 优先于 isAlive", () => {
      const agent = createAgent({
        started_at: Date.now() / 1000 - 31 * 60,
      });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => true });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.STALE);
      expect(proc.isAlive).not.toHaveBeenCalled();
    });

    it("isAlive 优先于 PID 检测", () => {
      const agent = createAgent({ pid: 12345 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => true, getPid: () => 12345 });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.RUNNING);
      expect(proc.getPid).not.toHaveBeenCalled();
    });

    it("exit_code=1 short-circuit（日志有内容也返回 CRASHED）", () => {
      const agent = createAgent({ exit_code: 1 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({
        isAlive: () => false,
        getRecentOutput: () => "plenty of log content here",
      });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getStatus("test-agent")).toBe(Status.CRASHED);
      expect(proc.getRecentOutput).not.toHaveBeenCalled();
    });
  });

  // === Transition callback ===

  describe("transition callback", () => {
    it("RUNNING→DONE 时触发回调", () => {
      const agent = createAgent({ exit_code: 0 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);

      const callback = vi.fn();
      detector.setTransitionCallback(callback);
      detector.getStatus("test-agent");

      expect(callback).toHaveBeenCalledWith("test-agent", Status.DONE);
    });

    it("RUNNING→CRASHED 时触发回调", () => {
      const agent = createAgent({ exit_code: 1 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);

      const callback = vi.fn();
      detector.setTransitionCallback(callback);
      detector.getStatus("test-agent");

      expect(callback).toHaveBeenCalledWith("test-agent", Status.CRASHED);
    });

    it("RUNNING→STALE 时触发回调", () => {
      const agent = createAgent({
        started_at: Date.now() / 1000 - 31 * 60,
      });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);

      const callback = vi.fn();
      detector.setTransitionCallback(callback);
      detector.getStatus("test-agent");

      expect(callback).toHaveBeenCalledWith("test-agent", Status.STALE);
    });

    it("状态不变（仍 RUNNING）→ 不触发回调", () => {
      const agent = createAgent();
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => true });
      detector = new StatusDetector(state, proc, 30);

      const callback = vi.fn();
      detector.setTransitionCallback(callback);
      detector.getStatus("test-agent");

      expect(callback).not.toHaveBeenCalled();
    });

    it("终态直返 → 不触发回调", () => {
      const agent = createAgent({ status: Status.ACCEPTED });
      state = createMockState({ "test-agent": agent });
      detector = new StatusDetector(state, proc, 30);

      const callback = vi.fn();
      detector.setTransitionCallback(callback);
      detector.getStatus("test-agent");

      expect(callback).not.toHaveBeenCalled();
    });

    it("回调异常不影响状态更新", () => {
      const agent = createAgent({ exit_code: 0 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);

      const badCallback = vi.fn(() => {
        throw new Error("callback boom");
      });
      detector.setTransitionCallback(badCallback);

      expect(detector.getStatus("test-agent")).toBe(Status.DONE);
      expect(state.updateAgentStatus).toHaveBeenCalledWith(
        "test-agent",
        Status.DONE,
      );
    });

    it("setTransitionCallback 构造后可调用", () => {
      const agent = createAgent({ exit_code: 0 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);

      detector.getStatus("test-agent");
      expect(state.updateAgentStatus).toHaveBeenCalledWith(
        "test-agent",
        Status.DONE,
      );

      const callback = vi.fn();
      state = createMockState({ "test-agent": createAgent({ exit_code: 0 }) });
      detector = new StatusDetector(state, proc, 30);
      detector.setTransitionCallback(callback);
      detector.getStatus("test-agent");
      expect(callback).toHaveBeenCalledWith("test-agent", Status.DONE);
    });
  });

  // === updateAgentStatus 副作用 ===

  describe("updateAgentStatus 副作用", () => {
    it("状态变更时调用 updateAgentStatus", () => {
      const agent = createAgent({ exit_code: 0 });
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => false });
      detector = new StatusDetector(state, proc, 30);

      detector.getStatus("test-agent");
      expect(state.updateAgentStatus).toHaveBeenCalledWith(
        "test-agent",
        Status.DONE,
      );
    });

    it("状态不变（仍 RUNNING）不调用 updateAgentStatus", () => {
      const agent = createAgent();
      state = createMockState({ "test-agent": agent });
      proc = createMockProcess({ isAlive: () => true });
      detector = new StatusDetector(state, proc, 30);

      detector.getStatus("test-agent");
      expect(state.updateAgentStatus).not.toHaveBeenCalled();
    });
  });

  // === getRecentOutput ===

  describe("getRecentOutput()", () => {
    it("委托 processManager.getRecentOutput", () => {
      proc = createMockProcess({ getRecentOutput: () => "output line" });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getRecentOutput("test-agent")).toBe("output line");
    });

    it("仅传递 name 参数", () => {
      const mockGetRecentOutput = vi.fn(() => "");
      proc = createMockProcess({ getRecentOutput: mockGetRecentOutput });
      detector = new StatusDetector(state, proc, 30);

      detector.getRecentOutput("test-agent");
      expect(mockGetRecentOutput).toHaveBeenCalledWith("test-agent");
    });
  });

  // === getDiff ===

  describe("getDiff()", () => {
    it("worktree 为 null → 返回空串", () => {
      const agent = createAgent({ worktree: null });
      state = createMockState({ "test-agent": agent });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getDiff("test-agent")).toBe("");
    });

    it("git 命令失败 → 返回空串", () => {
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error("git failed");
      });
      const agent = createAgent({ worktree: "/nonexistent" });
      state = createMockState({ "test-agent": agent });
      detector = new StatusDetector(state, proc, 30);

      expect(detector.getDiff("test-agent")).toBe("");
    });
  });

  // === 边界和防御性处理 ===

  describe("边界和防御性处理", () => {
    it("agent 不存在 → 抛 AgentNotFoundError", () => {
      state = createMockState({});
      detector = new StatusDetector(state, proc, 30);

      expect(() => detector.getStatus("nonexistent")).toThrow(
        AgentNotFoundError,
      );
    });

    it("getDiff agent 不存在 → 抛 AgentNotFoundError", () => {
      state = createMockState({});
      detector = new StatusDetector(state, proc, 30);

      expect(() => detector.getDiff("nonexistent")).toThrow(AgentNotFoundError);
    });
  });
});
