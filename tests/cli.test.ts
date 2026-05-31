import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProgram } from "../src/cli.js";
import { CliError } from "../src/cli-client.js";
import type { LoomerConfig } from "../src/config.js";
import type { LoomerClient } from "../src/cli-client.js";
import type { AgentInfo, PlanProgress } from "../src/types/web.js";

// mock LoomerClient
function createMockClient(): LoomerClient & {
  _calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const record = (method: string) => {
    return (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "status") return Promise.resolve([]);
      if (method === "log") return Promise.resolve("log output");
      if (method === "planStatus") return Promise.resolve(null);
      return Promise.resolve({ ok: true });
    };
  };

  return {
    _calls: calls,
    isServerRunning: record("isServerRunning"),
    start: record("start"),
    done: record("done"),
    kill: record("kill"),
    retry: record("retry"),
    accept: record("accept"),
    reject: record("reject"),
    status: record("status"),
    log: record("log"),
    planStatus: record("planStatus"),
  } as unknown as LoomerClient & {
    _calls: Array<{ method: string; args: unknown[] }>;
  };
}

// 捕获 console 输出
function captureOutput(): {
  logs: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;

  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  process.exit = ((_code?: number) => {}) as never;

  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    },
  };
}

describe("CLI program", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it("status calls client.status() and formats output", async () => {
    const program = createProgram(() => mockClient);
    const output = captureOutput();

    try {
      await program.parseAsync(["node", "loomer", "status"]);
      expect(mockClient._calls.some((c) => c.method === "status")).toBe(true);
      expect(output.logs.join("\n")).toContain("No agents found.");
    } finally {
      output.restore();
    }
  });

  it("status --all passes all=true", async () => {
    const program = createProgram(() => mockClient);
    const output = captureOutput();

    try {
      await program.parseAsync(["node", "loomer", "status", "--all"]);
      const statusCall = mockClient._calls.find(
        (c) => c.method === "status",
      );
      expect(statusCall).toBeDefined();
      expect(statusCall!.args[0]).toBe(true);
    } finally {
      output.restore();
    }
  });

  it("start calls client.start() with name and prompt", async () => {
    const program = createProgram(() => mockClient);
    const output = captureOutput();

    try {
      await program.parseAsync([
        "node",
        "loomer",
        "start",
        "my-agent",
        "--prompt",
        "do stuff",
      ]);
      const startCall = mockClient._calls.find(
        (c) => c.method === "start",
      );
      expect(startCall).toBeDefined();
      expect(startCall!.args).toEqual(["my-agent", "do stuff"]);
      expect(output.logs.join("\n")).toContain("started");
    } finally {
      output.restore();
    }
  });

  it("done calls client.done() with name", async () => {
    const program = createProgram(() => mockClient);
    await program.parseAsync(["node", "loomer", "done", "my-agent"]);
    const doneCall = mockClient._calls.find((c) => c.method === "done");
    expect(doneCall).toBeDefined();
    expect(doneCall!.args).toEqual(["my-agent"]);
  });

  it("kill calls client.kill() with name", async () => {
    const program = createProgram(() => mockClient);
    await program.parseAsync(["node", "loomer", "kill", "my-agent"]);
    const killCall = mockClient._calls.find((c) => c.method === "kill");
    expect(killCall).toBeDefined();
    expect(killCall!.args).toEqual(["my-agent", undefined]);
  });

  it("kill --clean passes clean=true", async () => {
    const program = createProgram(() => mockClient);
    await program.parseAsync(["node", "loomer", "kill", "my-agent", "--clean"]);
    const killCall = mockClient._calls.find((c) => c.method === "kill");
    expect(killCall).toBeDefined();
    expect(killCall!.args[1]).toBe(true);
  });

  it("retry calls client.retry() with name", async () => {
    const program = createProgram(() => mockClient);
    await program.parseAsync(["node", "loomer", "retry", "my-agent"]);
    const retryCall = mockClient._calls.find((c) => c.method === "retry");
    expect(retryCall).toBeDefined();
    expect(retryCall!.args).toEqual(["my-agent"]);
  });

  it("accept calls client.accept() with name", async () => {
    const program = createProgram(() => mockClient);
    await program.parseAsync(["node", "loomer", "accept", "my-agent"]);
    const acceptCall = mockClient._calls.find((c) => c.method === "accept");
    expect(acceptCall).toBeDefined();
    expect(acceptCall!.args).toEqual(["my-agent"]);
  });

  it("reject calls client.reject() with name", async () => {
    const program = createProgram(() => mockClient);
    await program.parseAsync(["node", "loomer", "reject", "my-agent"]);
    const rejectCall = mockClient._calls.find((c) => c.method === "reject");
    expect(rejectCall).toBeDefined();
    expect(rejectCall!.args).toEqual(["my-agent"]);
  });

  it("log calls client.log() with name and lines", async () => {
    const program = createProgram(() => mockClient);
    const output = captureOutput();

    try {
      await program.parseAsync([
        "node",
        "loomer",
        "log",
        "my-agent",
        "--lines",
        "100",
      ]);
      const logCall = mockClient._calls.find((c) => c.method === "log");
      expect(logCall).toBeDefined();
      expect(logCall!.args).toEqual(["my-agent", 100]);
      expect(output.logs.join("\n")).toContain("log output");
    } finally {
      output.restore();
    }
  });

  it("plan status calls client.planStatus()", async () => {
    const program = createProgram(() => mockClient);
    const output = captureOutput();

    try {
      await program.parseAsync(["node", "loomer", "plan", "status"]);
      const planCall = mockClient._calls.find(
        (c) => c.method === "planStatus",
      );
      expect(planCall).toBeDefined();
      expect(output.logs.join("\n")).toContain("No active plan.");
    } finally {
      output.restore();
    }
  });

  it("shows server-not-running message on connection failure", async () => {
    const failClient = createMockClient();
    failClient.start = (() =>
      Promise.reject(new CliError("fetch failed"))) as never;

    const program = createProgram(() => failClient);
    const output = captureOutput();

    try {
      await program.parseAsync([
        "node",
        "loomer",
        "start",
        "x",
        "--prompt",
        "y",
      ]);
      expect(output.errors.join("\n")).toContain("not running");
    } finally {
      output.restore();
    }
  });

  it("shows error message on server error", async () => {
    const failClient = createMockClient();
    failClient.start = (() =>
      Promise.reject(
        new CliError("Agent not found", "AgentNotFoundError", 400),
      )) as never;

    const program = createProgram(() => failClient);
    const output = captureOutput();

    try {
      await program.parseAsync([
        "node",
        "loomer",
        "start",
        "x",
        "--prompt",
        "y",
      ]);
      expect(output.errors.join("\n")).toContain("Agent not found");
    } finally {
      output.restore();
    }
  });
});
