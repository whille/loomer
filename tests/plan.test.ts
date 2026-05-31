import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PlanParser, DAGValidator, PlanExecutor } from "../src/plan.js";
import { PlanFormatError, DAGValidationError } from "../src/errors.js";
import type { LoomerAppLike } from "../src/types/web.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-plan-"));
}

// --- PlanParser ---

describe("PlanParser", () => {
  describe("fromPrdJson", () => {
    it("解析 prd.json 格式", () => {
      const dir = mkTmpDir();
      const prdPath = path.join(dir, "prd.json");
      fs.writeFileSync(prdPath, JSON.stringify({
        project: "test-project",
        taskSplit: [
          { id: "TS-001", userStory: "US-001", depends: [] },
          { id: "TS-002", userStory: "US-002", depends: ["TS-001"] },
        ],
        userStories: [
          { id: "US-001", description: "First task" },
          { id: "US-002", description: "Second task" },
        ],
      }));

      const spec = PlanParser.fromPrdJson(prdPath);
      expect(spec.name).toBe("test-project");
      expect(spec.tasks).toHaveLength(2);
      expect(spec.tasks[0].id).toBe("TS-001");
      expect(spec.tasks[0].prompt).toBe("First task");
      expect(spec.tasks[1].dependsOn).toEqual(["TS-001"]);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("prompt 回退到 title", () => {
      const dir = mkTmpDir();
      const prdPath = path.join(dir, "prd.json");
      fs.writeFileSync(prdPath, JSON.stringify({
        project: "test",
        taskSplit: [
          { id: "TS-001", userStory: "US-001", depends: [] },
        ],
        userStories: [
          { id: "US-001", title: "Fallback title" },
        ],
      }));

      const spec = PlanParser.fromPrdJson(prdPath);
      expect(spec.tasks[0].prompt).toBe("Fallback title");

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("prd.json 不存在抛 PlanFormatError", () => {
      expect(() => PlanParser.fromPrdJson("/nonexistent/prd.json")).toThrow(PlanFormatError);
    });

    it("maxConcurrent 从参数覆盖", () => {
      const dir = mkTmpDir();
      const prdPath = path.join(dir, "prd.json");
      fs.writeFileSync(prdPath, JSON.stringify({
        project: "test",
        taskSplit: [{ id: "TS-001", userStory: "US-001", depends: [] }],
        userStories: [{ id: "US-001", description: "test" }],
      }));

      const spec = PlanParser.fromPrdJson(prdPath, 3);
      expect(spec.maxConcurrent).toBe(3);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("parse (YAML frontmatter)", () => {
    it("解析 plan.md YAML frontmatter", () => {
      const dir = mkTmpDir();
      const planPath = path.join(dir, "plan.md");
      fs.writeFileSync(planPath, `---
name: my-plan
maxConcurrent: 3
tasks:
  - id: T-001
    prompt: "task one"
    dependsOn: []
  - id: T-002
    prompt: "task two"
    dependsOn:
      - T-001
---
# Plan content
`);

      const spec = PlanParser.parse(planPath);
      expect(spec.name).toBe("my-plan");
      expect(spec.maxConcurrent).toBe(3);
      expect(spec.tasks).toHaveLength(2);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});

// --- DAGValidator ---

describe("DAGValidator", () => {
  function makeSpec(tasks: Array<{ id: string; dependsOn: string[] }>) {
    return { name: "test", maxConcurrent: 5, tasks: tasks.map((t) => ({ ...t, prompt: "test" })) };
  }

  describe("规则 1: ID 合法性", () => {
    it("合法 ID 通过", () => {
      expect(() => DAGValidator.validate(makeSpec([
        { id: "LMR-001", dependsOn: [] },
      ]))).not.toThrow();
    });

    it("非法字符抛 DAGValidationError", () => {
      expect(() => DAGValidator.validate(makeSpec([
        { id: "bad id!", dependsOn: [] },
      ]))).toThrow(DAGValidationError);
    });

    it("超长 ID 抛 DAGValidationError", () => {
      expect(() => DAGValidator.validate(makeSpec([
        { id: "a".repeat(65), dependsOn: [] },
      ]))).toThrow(DAGValidationError);
    });
  });

  describe("规则 2: 无重复 ID", () => {
    it("重复 ID 抛 DAGValidationError", () => {
      expect(() => DAGValidator.validate(makeSpec([
        { id: "T-001", dependsOn: [] },
        { id: "T-001", dependsOn: [] },
      ]))).toThrow(DAGValidationError);
    });
  });

  describe("规则 3: 无缺失引用", () => {
    it("引用不存在的 ID 抛 DAGValidationError", () => {
      expect(() => DAGValidator.validate(makeSpec([
        { id: "T-001", dependsOn: ["T-999"] },
      ]))).toThrow(DAGValidationError);
    });
  });

  describe("规则 4: 无环 (Kahn)", () => {
    it("有环抛 DAGValidationError", () => {
      expect(() => DAGValidator.validate(makeSpec([
        { id: "T-001", dependsOn: ["T-002"] },
        { id: "T-002", dependsOn: ["T-001"] },
      ]))).toThrow(DAGValidationError);
    });

    it("无环通过", () => {
      expect(() => DAGValidator.validate(makeSpec([
        { id: "T-001", dependsOn: [] },
        { id: "T-002", dependsOn: ["T-001"] },
      ]))).not.toThrow();
    });
  });
});

// --- PlanExecutor ---

describe("PlanExecutor", () => {
  function makeMockApp(): LoomerAppLike {
    return {
      start: vi.fn(),
      done: vi.fn(),
      accept: vi.fn(),
      reject: vi.fn(),
      kill: vi.fn(),
      retry: vi.fn(),
      status: vi.fn(() => []),
      log: vi.fn(),
      diff: vi.fn(),
      runPlan: vi.fn(),
      planStatus: vi.fn(),
      planDag: vi.fn(),
    };
  }

  it("registerTasks 注册所有任务到 state", () => {
    const app = makeMockApp();
    const spec = {
      name: "test",
      maxConcurrent: 5,
      tasks: [
        { id: "T-001", prompt: "task one", dependsOn: [] },
        { id: "T-002", prompt: "task two", dependsOn: ["T-001"] },
      ],
    };
    const executor = new PlanExecutor(app, spec);
    // registerTasks 不抛异常
    expect(() => executor.registerTasks()).not.toThrow();
  });

  it("onTaskDone 依赖全满足返回新启动的 task IDs", () => {
    const app = makeMockApp();
    const spec = {
      name: "test",
      maxConcurrent: 5,
      tasks: [
        { id: "T-001", prompt: "task one", dependsOn: [] },
        { id: "T-002", prompt: "task two", dependsOn: ["T-001"] },
      ],
    };
    const executor = new PlanExecutor(app, spec);
    executor.registerTasks();

    // T-001 完成 → T-002 依赖满足 → 启动 T-002
    const started = executor.onTaskDone("T-001");
    expect(started).toContain("T-002");
  });

  it("onTaskDone 依赖未满足不启动", () => {
    const app = makeMockApp();
    const spec = {
      name: "test",
      maxConcurrent: 5,
      tasks: [
        { id: "T-001", prompt: "one", dependsOn: [] },
        { id: "T-002", prompt: "two", dependsOn: ["T-001"] },
        { id: "T-003", prompt: "three", dependsOn: ["T-001", "T-002"] },
      ],
    };
    const executor = new PlanExecutor(app, spec);
    executor.registerTasks();

    // T-001 完成 → T-002 依赖满足，T-003 还缺 T-002
    const started = executor.onTaskDone("T-001");
    expect(started).toContain("T-002");
    expect(started).not.toContain("T-003");
  });

  it("getProgress 返回正确进度", () => {
    const app = makeMockApp();
    const spec = {
      name: "test",
      maxConcurrent: 5,
      tasks: [
        { id: "T-001", prompt: "one", dependsOn: [] },
        { id: "T-002", prompt: "two", dependsOn: [] },
      ],
    };
    const executor = new PlanExecutor(app, spec);
    const progress = executor.getProgress();
    expect(progress.total).toBe(2);
  });

  it("isPlanComplete 初始为 false", () => {
    const app = makeMockApp();
    const spec = {
      name: "test",
      maxConcurrent: 5,
      tasks: [{ id: "T-001", prompt: "one", dependsOn: [] }],
    };
    const executor = new PlanExecutor(app, spec);
    expect(executor.isPlanComplete()).toBe(false);
  });
});
