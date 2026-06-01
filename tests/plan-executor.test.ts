import { describe, it, expect, vi } from "vitest";
import { PlanExecutor } from "../src/plan.js";
import type { PlanSpec } from "../src/plan.js";
import type { LoomerAppLike } from "../src/types/web.js";

function createMockApp(): LoomerAppLike & {
  started: string[];
  rejected: string[];
} {
  const started: string[] = [];
  const rejected: string[] = [];

  return {
    start: vi.fn((name: string, _prompt: string) => {
      started.push(name);
    }),
    done: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn((name: string) => {
      rejected.push(name);
    }),
    kill: vi.fn(),
    retry: vi.fn(),
    status: vi.fn(() => []),
    log: vi.fn(() => ""),
    diff: vi.fn(() => ""),
    runPlan: vi.fn(),
    planStatus: vi.fn(() => null),
    planDag: vi.fn(() => null),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    getServerPort: vi.fn(() => null),
    shutdown: vi.fn(),
    getTaskStatus: vi.fn(() => undefined),
    started,
    rejected,
  };
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
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B", dependsOn: ["A"] }]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();

      expect(app.start).not.toHaveBeenCalled();
      expect(executor.getProgress().pending).toBe(2);
    });

    it("root 任务数不超过 maxConcurrent 时全部可启动", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }], 2);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      const started = executor.launchReady();

      expect(started).toEqual(["A", "B"]);
      expect(app.start).toHaveBeenCalledTimes(2);
    });

    it("root 任务数超过 maxConcurrent 时只启动到上限", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }, { id: "C" }], 2);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      const started = executor.launchReady();

      expect(started).toEqual(["A", "B"]);
      expect(app.start).toHaveBeenCalledTimes(2);
    });

    it("有依赖的任务不立即启动", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      const started = executor.launchReady();

      expect(started).toEqual(["A"]);
      expect(app.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("onTaskDone", () => {
    it("依赖满足后启动子任务", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      const started = executor.onTaskDone("A");

      expect(started).toEqual(["B"]);
      expect(app.start).toHaveBeenCalledWith("B", "prompt for B");
    });

    it("多依赖：部分满足不启动", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      const started = executor.onTaskDone("A");

      expect(started).toEqual([]);
    });

    it("多依赖：全部满足后启动", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskDone("A");
      const started = executor.onTaskDone("B");

      expect(started).toEqual(["C"]);
    });

    it("级联拒绝：dep REJECTED → 子任务 REJECTED", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      const started = executor.onTaskRejected("A");

      expect(started).toEqual([]);
      expect(app.reject).toHaveBeenCalledWith("B");
    });

    it("级联拒绝：传递 A→B→C", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskRejected("A");

      expect(app.reject).toHaveBeenCalledWith("B");
      expect(app.reject).toHaveBeenCalledWith("C");
    });

    it("级联拒绝：规范顺序与依赖深度不一致时仍传播", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "C", dependsOn: ["B"] },
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      const launched = executor.launchReady();
      expect(launched).toEqual(["A"]);

      executor.onTaskRejected("A");

      expect(app.reject).toHaveBeenCalledWith("B");
      expect(app.reject).toHaveBeenCalledWith("C");
    });

    it("REJECTED + DONE 混合：一个 REJECTED 足以级联", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskDone("A");
      executor.onTaskRejected("B");

      expect(app.reject).toHaveBeenCalledWith("C");
    });

    it("DONE 和 ACCEPTED 都满足依赖", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B" },
        { id: "C", dependsOn: ["A", "B"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskDone("A");
      const started = executor.onTaskAccepted("B");

      expect(started).toEqual(["C"]);
    });

    it("无任务可启动时返回空数组", () => {
      const app = createMockApp();
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
      ]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();

      const started = executor.onTaskDone("nonexistent");

      expect(started).toEqual([]);
    });

    it("任务完成后释放 maxConcurrent 槽位", () => {
      const app = createMockApp();
      const spec = makeSpec(
        [
          { id: "A" },
          { id: "B" },
          { id: "C", dependsOn: ["A"] },
        ],
        2,
      );
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      expect(app.start).toHaveBeenCalledTimes(2);

      const started = executor.onTaskDone("A");
      expect(started).toEqual(["C"]);
    });
  });

  describe("isPlanComplete", () => {
    it("所有任务终态返回 true", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskDone("A");
      executor.onTaskRejected("B");

      expect(executor.isPlanComplete()).toBe(true);
    });

    it("混合终态返回 true", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }, { id: "C" }]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskAccepted("A");
      executor.onTaskCrashed("B");
      executor.onTaskConflicted("C");

      expect(executor.isPlanComplete()).toBe(true);
    });

    it("有 RUNNING 返回 false", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskDone("A");

      expect(executor.isPlanComplete()).toBe(false);
    });

    it("有 PENDING 返回 false", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskDone("A");

      expect(executor.isPlanComplete()).toBe(false);
    });

    it("空计划返回 true", () => {
      const app = createMockApp();
      const spec: PlanSpec = { name: "empty", maxConcurrent: 5, tasks: [] };
      const executor = new PlanExecutor(app, spec);

      expect(executor.isPlanComplete()).toBe(true);
    });
  });

  describe("getProgress", () => {
    it("统计各状态计数", () => {
      const app = createMockApp();
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
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady(); // A..E 启动（maxConcurrent=5）
      executor.onTaskDone("A");
      executor.onTaskAccepted("B");
      // C 仍为 RUNNING
      // D 仍为 RUNNING (was launched)
      executor.onTaskCrashed("E");
      executor.onTaskConflicted("F");
      executor.onTaskStale("G");
      executor.onTaskReview("H");

      const progress = executor.getProgress();
      expect(progress).toEqual({
        plan: "test-plan",
        total: 8,
        done: 2,
        running: 2,
        pending: 0,
        crashed: 1,
        conflicted: 1,
        stale: 1,
        review: 1,
      });
    });

    it("done 包含 DONE + ACCEPTED", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskDone("A");
      executor.onTaskAccepted("B");

      const progress = executor.getProgress();
      expect(progress.done).toBe(2);
    });

    it("review 包含 REVIEW + REJECTED", () => {
      const app = createMockApp();
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      const executor = new PlanExecutor(app, spec);

      executor.registerTasks();
      executor.launchReady();
      executor.onTaskReview("A");
      executor.onTaskRejected("B");

      const progress = executor.getProgress();
      expect(progress.review).toBe(2);
    });

    it("plan 名称与 spec.name 一致", () => {
      const app = createMockApp();
      const spec: PlanSpec = { name: "my-project", maxConcurrent: 3, tasks: [] };
      const executor = new PlanExecutor(app, spec);

      expect(executor.getProgress().plan).toBe("my-project");
    });

    it("空计划全为零", () => {
      const app = createMockApp();
      const spec: PlanSpec = { name: "empty", maxConcurrent: 5, tasks: [] };
      const executor = new PlanExecutor(app, spec);

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
