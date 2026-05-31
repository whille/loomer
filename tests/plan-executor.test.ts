import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlanExecutor } from "../src/plan.js";
import type { IPlanContext, PlanSpec } from "../src/plan.js";
import { Status } from "../src/status.js";

function createMockPlanContext(
  overrides: Partial<IPlanContext> = {},
): IPlanContext & {
  agents: Map<string, { status: string; prompt: string; dependsOn: string[]; plan: string }>;
} {
  const agents = new Map<
    string,
    { status: string; prompt: string; dependsOn: string[]; plan: string }
  >();
  const base: IPlanContext = {
    registerAgent: vi.fn((name, prompt, dependsOn, plan) => {
      agents.set(name, { status: Status.PENDING, prompt, dependsOn, plan });
    }),
    launchAgent: vi.fn((name) => {
      const agent = agents.get(name);
      if (agent) agent.status = Status.RUNNING;
    }),
    rejectAgent: vi.fn((name) => {
      const agent = agents.get(name);
      if (agent) agent.status = Status.REJECTED;
    }),
    getAgentStatus: vi.fn((name) => agents.get(name)?.status ?? null),
    getRunningCount: vi.fn(() => {
      let count = 0;
      for (const a of agents.values()) {
        if (a.status === Status.RUNNING) count++;
      }
      return count;
    }),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "function") {
      (base as Record<string, unknown>)[key] = vi.fn(value);
    }
  }

  return { ...base, agents };
}

function makeSpec(
  tasks: { id: string; dependsOn?: string[] }[],
  maxConcurrent = 5,
): PlanSpec {
  return {
    name: "test-plan",
    maxConcurrent,
    tasks: tasks.map((t) => ({
      id: t.id,
      prompt: `prompt for ${t.id}`,
      dependsOn: t.dependsOn ?? [],
    })),
  };
}

describe("PlanExecutor", () => {
  describe("registerTasks", () => {
    it("注册所有任务为 PENDING", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B", dependsOn: ["A"] }]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();

      expect(ctx.registerAgent).toHaveBeenCalledTimes(2);
      expect(ctx.registerAgent).toHaveBeenCalledWith(
        "A",
        "prompt for A",
        [],
        "test-plan",
      );
      expect(ctx.registerAgent).toHaveBeenCalledWith(
        "B",
        "prompt for B",
        ["A"],
        "test-plan",
      );
    });

    it("启动无依赖的 root 任务", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(ctx, spec);

      const started = executor.registerTasks();

      expect(started).toEqual(["A", "B"]);
      expect(ctx.launchAgent).toHaveBeenCalledTimes(2);
    });

    it("root 任务数超过 maxConcurrent 时只启动到上限", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }, { id: "C" }], 2);
      const executor = new PlanExecutor(ctx, spec);

      const started = executor.registerTasks();

      expect(started).toEqual(["A", "B"]);
      expect(ctx.launchAgent).toHaveBeenCalledTimes(2);
    });

    it("有依赖的任务不立即启动", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      const started = executor.registerTasks();

      expect(started).toEqual(["A"]);
      expect(ctx.launchAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe("onTaskDone", () => {
    it("依赖满足后启动子任务", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      // 模拟 A 完成
      ctx.agents.get("A")!.status = Status.DONE;

      const started = executor.onTaskDone("A");

      expect(started).toEqual(["B"]);
      expect(ctx.launchAgent).toHaveBeenCalledWith("B");
    });

    it("多依赖：部分满足不启动", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks(); // A, B 启动
      ctx.agents.get("A")!.status = Status.DONE;
      // B 仍为 RUNNING

      const started = executor.onTaskDone("A");

      expect(started).toEqual([]);
    });

    it("多依赖：全部满足后启动", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.DONE;
      ctx.agents.get("B")!.status = Status.ACCEPTED;

      const started = executor.onTaskDone("B");

      expect(started).toEqual(["C"]);
    });

    it("级联拒绝：dep REJECTED → 子任务 REJECTED", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.REJECTED;

      const started = executor.onTaskDone("A");

      expect(started).toEqual([]);
      expect(ctx.rejectAgent).toHaveBeenCalledWith("B");
      expect(ctx.agents.get("B")!.status).toBe(Status.REJECTED);
    });

    it("级联拒绝：传递 A→B→C", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.REJECTED;

      executor.onTaskDone("A");

      expect(ctx.agents.get("B")!.status).toBe(Status.REJECTED);
      // C 需要 B 的拒绝也被传播——固定点迭代确保多层级联
      expect(ctx.agents.get("C")!.status).toBe(Status.REJECTED);
    });

    it("级联拒绝：规范顺序与依赖深度不一致时仍传播", () => {
      const ctx = createMockPlanContext();
      // 规范顺序：C, A, B — C 在 B 之前列出，但依赖 B
      const spec = makeSpec([
        { id: "C", dependsOn: ["B"] },
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      // 验证 registerTasks 后的状态
      expect(ctx.agents.get("A")!.status).toBe(Status.RUNNING);
      expect(ctx.agents.get("B")!.status).toBe(Status.PENDING);
      expect(ctx.agents.get("C")!.status).toBe(Status.PENDING);

      ctx.agents.get("A")!.status = Status.REJECTED;

      executor.onTaskDone("A");

      expect(ctx.agents.get("B")!.status).toBe(Status.REJECTED);
      expect(ctx.agents.get("C")!.status).toBe(Status.REJECTED);
    });

    it("REJECTED + DONE 混合：一个 REJECTED 足以级联", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.REJECTED;
      ctx.agents.get("B")!.status = Status.DONE;

      executor.onTaskDone("A");

      expect(ctx.agents.get("C")!.status).toBe(Status.REJECTED);
    });

    it("DONE 和 ACCEPTED 都满足依赖", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.DONE;
      ctx.agents.get("B")!.status = Status.ACCEPTED;

      const started = executor.onTaskDone("B");

      expect(started).toEqual(["C"]);
    });

    it("无任务可启动时返回空数组", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      // A 仍为 RUNNING，B 的依赖未满足

      const started = executor.onTaskDone("nothing-relevant");

      expect(started).toEqual([]);
    });

    it("任务完成后释放 maxConcurrent 槽位", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec(
        [
          { id: "A" },
          { id: "B" },
          { id: "C", dependsOn: ["A"] },
        ],
        2,
      );
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks(); // A, B 启动（maxConcurrent=2）
      expect(ctx.launchAgent).toHaveBeenCalledTimes(2);

      // A 完成，释放一个槽位，C 可以启动
      ctx.agents.get("A")!.status = Status.DONE;

      const started = executor.onTaskDone("A");
      expect(started).toEqual(["C"]);
    });
  });

  describe("isPlanComplete", () => {
    it("所有任务终态返回 true", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.DONE;
      ctx.agents.get("B")!.status = Status.REJECTED;

      expect(executor.isPlanComplete()).toBe(true);
    });

    it("混合终态返回 true", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }, { id: "C" }]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.ACCEPTED;
      ctx.agents.get("B")!.status = Status.CRASHED;
      ctx.agents.get("C")!.status = Status.CONFLICTED;

      expect(executor.isPlanComplete()).toBe(true);
    });

    it("有 RUNNING 返回 false", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.DONE;
      // B 仍为 RUNNING

      expect(executor.isPlanComplete()).toBe(false);
    });

    it("有 PENDING 返回 false", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.DONE;
      ctx.agents.get("B")!.status = Status.PENDING;

      expect(executor.isPlanComplete()).toBe(false);
    });

    it("空计划返回 true", () => {
      const ctx = createMockPlanContext();
      const spec: PlanSpec = { name: "empty", maxConcurrent: 5, tasks: [] };
      const executor = new PlanExecutor(ctx, spec);

      expect(executor.isPlanComplete()).toBe(true);
    });
  });

  describe("getProgress", () => {
    it("统计各状态计数", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C" },
        { id: "D" },
        { id: "E" },
        { id: "F" },
        { id: "G" },
        { id: "H" },
      ]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.DONE;
      ctx.agents.get("B")!.status = Status.ACCEPTED;
      // C 仍为 RUNNING
      ctx.agents.get("D")!.status = Status.PENDING;
      ctx.agents.get("E")!.status = Status.CRASHED;
      ctx.agents.get("F")!.status = Status.CONFLICTED;
      ctx.agents.get("G")!.status = Status.STALE;
      ctx.agents.get("H")!.status = Status.REVIEW;

      const progress = executor.getProgress();
      expect(progress).toEqual({
        plan: "test-plan",
        total: 8,
        done: 2,
        running: 1,
        pending: 1,
        crashed: 1,
        conflicted: 1,
        stale: 1,
        review: 1,
      });
    });

    it("done 包含 DONE + ACCEPTED", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.DONE;
      ctx.agents.get("B")!.status = Status.ACCEPTED;

      const progress = executor.getProgress();
      expect(progress.done).toBe(2);
    });

    it("review 包含 REVIEW + REJECTED", () => {
      const ctx = createMockPlanContext();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(ctx, spec);

      executor.registerTasks();
      ctx.agents.get("A")!.status = Status.REVIEW;
      ctx.agents.get("B")!.status = Status.REJECTED;

      const progress = executor.getProgress();
      expect(progress.review).toBe(2);
    });

    it("plan 名称与 spec.name 一致", () => {
      const ctx = createMockPlanContext();
      const spec: PlanSpec = { name: "my-project", maxConcurrent: 3, tasks: [] };
      const executor = new PlanExecutor(ctx, spec);

      expect(executor.getProgress().plan).toBe("my-project");
    });

    it("空计划全为零", () => {
      const ctx = createMockPlanContext();
      const spec: PlanSpec = { name: "empty", maxConcurrent: 5, tasks: [] };
      const executor = new PlanExecutor(ctx, spec);

      const progress = executor.getProgress();
      expect(progress).toEqual({
        plan: "empty",
        total: 0,
        done: 0,
        running: 0,
        pending: 0,
        crashed: 0,
        conflicted: 0,
        stale: 0,
        review: 0,
      });
    });
  });
});
