import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";

// vi.mock 提升到顶部执行
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { AgentNotFoundError, LoomerError } from "../src/errors.js";
import { ProcessManager, type ProcessInfo } from "../src/process.js";

// --- Mock 工厂 ---

const mockSpawn = vi.mocked(childProcess).spawn;

function createDefaultConfig() {
  return {
    baseBranch: "main",
    claudePath: "claude",
    claudeArgs: [] as string[],
    defaultPort: 3000,
    defaultTimeoutMinutes: 30,
    maxConcurrent: 5,
    stateDir: "/tmp/loomer-test",
    skillPrefix: true,
    mergeStrategy: "auto" as const,
    createPr: true,
    autoMergeRules: {
      maxFiles: 10,
      maxLines: 500,
      conflict: "review" as const,
      testFail: "review" as const,
    },
  };
}

function createMockChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    kill: vi.fn(),
    stdin,
    stdout,
    stderr,
  });
  mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);
  return { child, stdout, stderr };
}

// === Phase 1: _parseStreamJson ===

describe("ProcessManager._parseStreamJson", () => {
  it("extracts text from content_block_delta with text_delta", () => {
    const lines = [
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("hello");
  });

  it("concatenates multiple content_block_deltas", () => {
    const lines = [
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: " world" },
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("hello world");
  });

  it("extracts text from result event", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        result: [{ type: "text", text: "done" }],
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("done");
  });

  it("handles mixed content_block_delta and result events", () => {
    const lines = [
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      }),
      JSON.stringify({
        type: "result",
        result: [{ type: "text", text: " final" }],
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("partial final");
  });

  it("skips non-JSON lines", () => {
    const lines = [
      "this is not json",
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "valid" },
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("valid");
  });

  it("skips empty lines", () => {
    const lines = [
      "",
      "  ",
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "data" },
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("data");
  });

  it("skips delta with non-text_delta type", () => {
    const lines = [
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"key"' },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "kept" },
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("kept");
  });

  it("skips result blocks with non-text type", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        result: [{ type: "tool_use", name: "Read" }],
      }),
      JSON.stringify({
        type: "result",
        result: [{ type: "text", text: "kept" }],
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe("kept");
  });

  it("falls back to raw lines when no JSON parsed", () => {
    const lines = ["line one", "line two"];
    expect(ProcessManager._parseStreamJson(lines)).toBe("line one\nline two");
  });

  it("returns empty string for empty array", () => {
    expect(ProcessManager._parseStreamJson([])).toBe("");
  });

  it("handles realistic multi-event stream", () => {
    const lines = [
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "I'll " },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "help you." },
      }),
      JSON.stringify({
        type: "result",
        result: [{ type: "text", text: "I'll help you." }],
      }),
    ];
    expect(ProcessManager._parseStreamJson(lines)).toBe(
      "I'll help you.I'll help you.",
    );
  });
});

// === Phase 2: start() lifecycle ===

describe("ProcessManager.start", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    pm = new ProcessManager(createDefaultConfig());
  });

  it("spawns with correct args including hardcoded flags", () => {
    createMockChild();
    pm.start("agent-1", "/worktree", "do stuff");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "do stuff",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ],
      { cwd: "/worktree", stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("appends config.claudeArgs after hardcoded flags", () => {
    const config = createDefaultConfig();
    config.claudeArgs = ["--model", "sonnet"];
    createMockChild();
    const pmWithArgs = new ProcessManager(config);

    pmWithArgs.start("agent-1", "/worktree", "do stuff");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "do stuff",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        "sonnet",
      ],
      expect.any(Object),
    );
  });

  it("passes prompt via stdin pipe", () => {
    const { child } = createMockChild();
    pm.start("agent-1", "/worktree", "my prompt");

    expect(child.stdin.write).toHaveBeenCalledWith("my prompt");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("uses worktreePath as cwd", () => {
    createMockChild();
    pm.start("agent-1", "/custom/path", "prompt");

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      { cwd: "/custom/path", stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("throws if agent with same name is already running", () => {
    createMockChild();
    pm.start("agent-1", "/worktree", "prompt");

    expect(() => pm.start("agent-1", "/worktree", "another")).toThrow(
      LoomerError,
    );
  });
});

// === Phase 3: State queries ===

describe("ProcessManager state queries", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    pm = new ProcessManager(createDefaultConfig());
  });

  describe("isAlive", () => {
    it("returns true while running", () => {
      createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      expect(pm.isAlive("agent-1")).toBe(true);
    });

    it("returns false after exit", () => {
      const { child } = createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      child.emit("exit", 0);
      expect(pm.isAlive("agent-1")).toBe(false);
    });

    it("returns false for unknown name", () => {
      expect(pm.isAlive("unknown")).toBe(false);
    });
  });

  describe("hasExited", () => {
    it("returns true after exit event", () => {
      const { child } = createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      child.emit("exit", 0);
      expect(pm.hasExited("agent-1")).toBe(true);
    });

    it("returns false while running", () => {
      createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      expect(pm.hasExited("agent-1")).toBe(false);
    });

    it("returns false for unknown name", () => {
      expect(pm.hasExited("unknown")).toBe(false);
    });
  });

  describe("getExitCode", () => {
    it("returns code after exit", () => {
      const { child } = createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      child.emit("exit", 1);
      expect(pm.getExitCode("agent-1")).toBe(1);
    });

    it("returns null before exit", () => {
      createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      expect(pm.getExitCode("agent-1")).toBeNull();
    });

    it("returns null for unknown name", () => {
      expect(pm.getExitCode("unknown")).toBeNull();
    });

    it("returns 0 for successful exit", () => {
      const { child } = createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      child.emit("exit", 0);
      expect(pm.getExitCode("agent-1")).toBe(0);
    });
  });

  describe("getPid", () => {
    it("returns child.pid", () => {
      createMockChild();
      pm.start("agent-1", "/worktree", "prompt");
      expect(pm.getPid("agent-1")).toBe(12345);
    });

    it("returns null for unknown name", () => {
      expect(pm.getPid("unknown")).toBeNull();
    });
  });
});

// === Phase 4: Output accumulation ===

describe("ProcessManager output", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    pm = new ProcessManager(createDefaultConfig());
  });

  it("accumulates stdout data as lines", () => {
    const { stdout } = createMockChild();
    pm.start("agent-1", "/worktree", "prompt");

    stdout.emit("data", Buffer.from('{"type":"init"}\n'));
    stdout.emit(
      "data",
      Buffer.from(
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n',
      ),
    );

    expect(pm._getWorkerLog("agent-1")).toContain("content_block_delta");
  });

  it("getRecentOutput applies _parseStreamJson", () => {
    const { stdout } = createMockChild();
    pm.start("agent-1", "/worktree", "prompt");

    stdout.emit(
      "data",
      Buffer.from(
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n',
      ),
    );

    expect(pm.getRecentOutput("agent-1")).toBe("hello");
  });

  it("getRecentOutput respects lines parameter", () => {
    const { stdout } = createMockChild();
    pm.start("agent-1", "/worktree", "prompt");

    for (const t of ["line1\n", "line2\n", "line3\n"]) {
      stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: t },
          }) + "\n",
        ),
      );
    }

    const output = pm.getRecentOutput("agent-1", 2);
    const resultLines = output.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(2);
  });

  it("getRecentOutput throws AgentNotFoundError for unknown", () => {
    expect(() => pm.getRecentOutput("unknown")).toThrow(AgentNotFoundError);
  });

  it("_getWorkerLog throws AgentNotFoundError for unknown", () => {
    expect(() => pm._getWorkerLog("unknown")).toThrow(AgentNotFoundError);
  });
});

// === Phase 5: stop + listProcesses ===

describe("ProcessManager.stop", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    pm = new ProcessManager(createDefaultConfig());
  });

  it("sends SIGTERM to running process", () => {
    const { child } = createMockChild();
    pm.start("agent-1", "/worktree", "prompt");
    pm.stop("agent-1");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("throws AgentNotFoundError for unknown name", () => {
    expect(() => pm.stop("unknown")).toThrow(AgentNotFoundError);
  });

  it("is idempotent on already-exited process", () => {
    const { child } = createMockChild();
    pm.start("agent-1", "/worktree", "prompt");
    child.emit("exit", 0);

    expect(() => pm.stop("agent-1")).not.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("ProcessManager.listProcesses", () => {
  it("returns ProcessInfo array", () => {
    createMockChild();
    const pm = new ProcessManager(createDefaultConfig());
    pm.start("a1", "/w1", "p1");
    pm.start("a2", "/w2", "p2");

    const list = pm.listProcesses();
    expect(list).toEqual([
      { name: "a1", pid: 12345, alive: true },
      { name: "a2", pid: 12345, alive: true },
    ]);
  });

  it("returns empty array when no processes", () => {
    const pm = new ProcessManager(createDefaultConfig());
    expect(pm.listProcesses()).toEqual([]);
  });
});

// === Phase 6: Edge cases ===

describe("ProcessManager edge cases", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    pm = new ProcessManager(createDefaultConfig());
  });

  it("logs stderr data as warning", () => {
    const { stderr } = createMockChild();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    pm.start("agent-1", "/worktree", "prompt");

    stderr.emit("data", Buffer.from("some error output"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("some error output"),
    );
    warnSpy.mockRestore();
  });

  it("handles partial lines across chunks", () => {
    const { stdout } = createMockChild();
    pm.start("agent-1", "/worktree", "prompt");

    stdout.emit("data", Buffer.from('{"type":"content_block'));
    stdout.emit(
      "data",
      Buffer.from(
        '_delta","delta":{"type":"text_delta","text":"hi"}}\nnext line\n',
      ),
    );

    const log = pm._getWorkerLog("agent-1");
    expect(log).toContain("content_block_delta");
    expect(log).toContain("next line");
  });
});
