import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IProcessManager } from "../src/status.js";
import { ProcessManager } from "../src/process.js";
import { LoomerConfig } from "../src/config.js";
import type { StateStore } from "../src/state.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

function makeConfig(): LoomerConfig {
  return new LoomerConfig();
}

function makeMockState(): StateStore {
  return {
    updateAgent: vi.fn(),
  } as unknown as StateStore;
}

function makeFakeChild() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const fakeStdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  return {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(cb);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
    pid: 12345,
    stdin: fakeStdin,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    killed: false,
  };
}

describe("ProcessManager", () => {
  let config: LoomerConfig;
  let state: StateStore;
  let pm: ProcessManager;

  beforeEach(() => {
    config = makeConfig();
    state = makeMockState();
    pm = new ProcessManager(config, state);
    vi.mocked(spawn).mockReset();
  });

  describe("start", () => {
    it("spawn 包含三件套硬编码参数", () => {
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      pm.start("test-agent", "/worktree/path", "do something");

      const [cmd, args, options] = vi.mocked(spawn).mock.calls[0];
      expect(cmd).toBe("claude");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--verbose");
      expect(args).toContain("--include-partial-messages");
      expect(args).toContain("-p");
    });

    it("使用 worktreePath 作为 cwd", () => {
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      pm.start("test-agent", "/worktree/path", "do something");

      const options = vi.mocked(spawn).mock.calls[0][2];
      expect(options.cwd).toBe("/worktree/path");
    });

    it("stdin pipe 传 prompt", () => {
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      pm.start("test-agent", "/worktree/path", "test prompt");

      expect(fakeChild.stdin.write).toHaveBeenCalledWith("test prompt");
      expect(fakeChild.stdin.end).toHaveBeenCalled();
    });

    it("exit 回调写 exit_code 到 state", () => {
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      pm.start("test-agent", "/worktree/path", "prompt");

      // 模拟 exit 事件
      fakeChild.emit("exit", 0);

      expect(state.updateAgent).toHaveBeenCalledWith("test-agent", { exit_code: 0, pid: null });
    });
  });

  describe("isAlive / hasExited / getExitCode", () => {
    it("start 后 isAlive 返回 true", () => {
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      pm.start("test-agent", "/worktree", "prompt");
      expect(pm.isAlive("test-agent")).toBe(true);
    });

    it("exit 后 hasExited 返回 true", () => {
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      pm.start("test-agent", "/worktree", "prompt");
      fakeChild.emit("exit", 1);

      expect(pm.hasExited("test-agent")).toBe(true);
      expect(pm.getExitCode("test-agent")).toBe(1);
      expect(pm.isAlive("test-agent")).toBe(false);
    });

    it("未知 agent 返回 false/null", () => {
      expect(pm.isAlive("unknown")).toBe(false);
      expect(pm.hasExited("unknown")).toBe(false);
      expect(pm.getExitCode("unknown")).toBeNull();
      expect(pm.getPid("unknown")).toBeNull();
    });
  });

  describe("stop", () => {
    it("对存活的进程调用 kill", () => {
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      pm.start("test-agent", "/worktree", "prompt");
      pm.stop("test-agent");

      expect(fakeChild.kill).toHaveBeenCalled();
    });

    it("对不存在的进程不报错", () => {
      expect(() => pm.stop("nonexistent")).not.toThrow();
    });
  });

  describe("_parseStreamJson", () => {
    it("解析 content_block_delta 事件", () => {
      const lines = [
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } }),
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "World" } }),
      ];
      const result = ProcessManager.parseStreamJson(lines);
      expect(result).toBe("Hello World");
    });

    it("解析 result 事件", () => {
      const lines = [
        JSON.stringify({ type: "result", result: [{ type: "text", text: "final answer" }] }),
      ];
      const result = ProcessManager.parseStreamJson(lines);
      expect(result).toBe("final answer");
    });

    it("跳过非 JSON 行", () => {
      const lines = ["not json", ""];
      const result = ProcessManager.parseStreamJson(lines);
      expect(result.trim()).toBe("not json");
    });

    it("空输入返回空串", () => {
      expect(ProcessManager.parseStreamJson([])).toBe("");
    });
  });
});
