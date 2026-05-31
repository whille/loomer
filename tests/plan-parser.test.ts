import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PlanParser, DAGValidator } from "../src/plan.js";
import type { PlanSpec } from "../src/plan.js";
import { PlanFormatError, DAGValidationError } from "../src/errors.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-plan-"));
}

function writePlanMd(content: string): string {
  const dir = mkTmpDir();
  const filePath = path.join(dir, "plan.md");
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writePrdJson(data: object): string {
  const dir = mkTmpDir();
  const filePath = path.join(dir, "prd.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// === DAGValidator ===

describe("DAGValidator", () => {
  function makeSpec(
    tasks: { id: string; dependsOn?: string[] }[],
  ): PlanSpec {
    return {
      name: "test-plan",
      maxConcurrent: 5,
      tasks: tasks.map((t) => ({
        id: t.id,
        prompt: `prompt for ${t.id}`,
        dependsOn: t.dependsOn ?? [],
      })),
    };
  }

  describe("规则 1: ID 合法性", () => {
    it("合法 ID: 字母数字连字符下划线", () => {
      const spec = makeSpec([{ id: "LMR-001" }, { id: "feat_branch" }, { id: "abc123" }]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });

    it("合法 ID: 恰好 64 字符", () => {
      const spec = makeSpec([{ id: "a".repeat(64) }]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });

    it("非法 ID: 空字符串", () => {
      const spec = makeSpec([{ id: "" }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });

    it("非法 ID: 含空格", () => {
      const spec = makeSpec([{ id: "bad name" }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });

    it("非法 ID: 含特殊字符", () => {
      const spec = makeSpec([{ id: "bad@name!" }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });

    it("非法 ID: 超过 64 字符", () => {
      const spec = makeSpec([{ id: "a".repeat(65) }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });

    it("非法 ID: 含点号", () => {
      const spec = makeSpec([{ id: "bad.name" }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });

    it("非法 ID: 含斜杠", () => {
      const spec = makeSpec([{ id: "bad/name" }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });
  });

  describe("规则 2: 无重复 ID", () => {
    it("不重复时通过", () => {
      const spec = makeSpec([{ id: "A" }, { id: "B" }]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });

    it("重复 ID 抛 PlanFormatError", () => {
      const spec = makeSpec([{ id: "A" }, { id: "A" }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });
  });

  describe("规则 3: 无缺失引用", () => {
    it("引用存在时通过", () => {
      const spec = makeSpec([
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["A"] },
      ]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });

    it("引用不存在的 ID 抛 PlanFormatError", () => {
      const spec = makeSpec([
        { id: "A", dependsOn: [] },
        { id: "B", dependsOn: ["C"] },
      ]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });
  });

  describe("规则 4: 无环（Kahn）", () => {
    it("无环 DAG 通过", () => {
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["A"] },
        { id: "D", dependsOn: ["B", "C"] },
      ]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });

    it("线性链通过", () => {
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
      ]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });

    it("自环抛 DAGValidationError", () => {
      const spec = makeSpec([{ id: "A", dependsOn: ["A"] }]);
      expect(() => DAGValidator.validate(spec)).toThrow(DAGValidationError);
    });

    it("简单环 A→B→A 抛 DAGValidationError", () => {
      const spec = makeSpec([
        { id: "A", dependsOn: ["B"] },
        { id: "B", dependsOn: ["A"] },
      ]);
      expect(() => DAGValidator.validate(spec)).toThrow(DAGValidationError);
    });

    it("长环 A→B→C→A 抛 DAGValidationError", () => {
      const spec = makeSpec([
        { id: "A", dependsOn: ["C"] },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["B"] },
      ]);
      expect(() => DAGValidator.validate(spec)).toThrow(DAGValidationError);
    });

    it("菱形 DAG 通过", () => {
      const spec = makeSpec([
        { id: "A" },
        { id: "B", dependsOn: ["A"] },
        { id: "C", dependsOn: ["A"] },
        { id: "D", dependsOn: ["B", "C"] },
      ]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });
  });

  describe("规则顺序", () => {
    it("非法 ID 优先于环检测", () => {
      const spec = makeSpec([{ id: "bad@id", dependsOn: ["bad@id"] }]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });

    it("重复 ID 优先于环检测", () => {
      const spec = makeSpec([
        { id: "A", dependsOn: ["B"] },
        { id: "A", dependsOn: ["A"] },
      ]);
      expect(() => DAGValidator.validate(spec)).toThrow(PlanFormatError);
    });
  });

  describe("边界", () => {
    it("空任务列表通过", () => {
      const spec: PlanSpec = { name: "empty", maxConcurrent: 5, tasks: [] };
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });

    it("独立无依赖任务通过", () => {
      const spec = makeSpec([{ id: "A" }, { id: "B" }, { id: "C" }]);
      expect(() => DAGValidator.validate(spec)).not.toThrow();
    });
  });
});

// === PlanParser.parse ===

describe("PlanParser.parse", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTmpPlan(content: string): string {
    const filePath = path.join(tmpDir, "plan.md");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("解析有效的 plan.md", () => {
    const filePath = writeTmpPlan(`---
name: my-plan
maxConcurrent: 3
tasks:
  - id: task-1
    prompt: "Do something"
    dependsOn: []
  - id: task-2
    prompt: "Do another"
    dependsOn:
      - task-1
---
Body text here`);
    const spec = PlanParser.parse(filePath);
    expect(spec.name).toBe("my-plan");
    expect(spec.maxConcurrent).toBe(3);
    expect(spec.tasks).toHaveLength(2);
    expect(spec.tasks[0]).toEqual({
      id: "task-1",
      prompt: "Do something",
      dependsOn: [],
    });
    expect(spec.tasks[1]).toEqual({
      id: "task-2",
      prompt: "Do another",
      dependsOn: ["task-1"],
    });
  });

  it("maxConcurrent 缺失时默认 5", () => {
    const filePath = writeTmpPlan(`---
name: simple
tasks:
  - id: t1
    prompt: "hi"
---
`);
    const spec = PlanParser.parse(filePath);
    expect(spec.maxConcurrent).toBe(5);
  });

  it("dependsOn 缺失时默认空数组", () => {
    const filePath = writeTmpPlan(`---
name: no-deps
tasks:
  - id: t1
    prompt: "hi"
---
`);
    const spec = PlanParser.parse(filePath);
    expect(spec.tasks[0].dependsOn).toEqual([]);
  });

  it("无 frontmatter 抛 PlanFormatError", () => {
    const filePath = writeTmpPlan("Just some text\nNo frontmatter");
    expect(() => PlanParser.parse(filePath)).toThrow(PlanFormatError);
  });

  it("缺失 name 抛 PlanFormatError", () => {
    const filePath = writeTmpPlan(`---
tasks:
  - id: t1
    prompt: "hi"
---
`);
    expect(() => PlanParser.parse(filePath)).toThrow(PlanFormatError);
  });

  it("缺失 tasks 抛 PlanFormatError", () => {
    const filePath = writeTmpPlan(`---
name: no-tasks
---
`);
    expect(() => PlanParser.parse(filePath)).toThrow(PlanFormatError);
  });

  it("task 缺失 id 抛 PlanFormatError", () => {
    const filePath = writeTmpPlan(`---
name: bad-task
tasks:
  - prompt: "no id"
---
`);
    expect(() => PlanParser.parse(filePath)).toThrow(PlanFormatError);
  });

  it("task 缺失 prompt 抛 PlanFormatError", () => {
    const filePath = writeTmpPlan(`---
name: bad-task
tasks:
  - id: t1
---
`);
    expect(() => PlanParser.parse(filePath)).toThrow(PlanFormatError);
  });

  it("文件不存在时抛 ENOENT", () => {
    expect(() => PlanParser.parse("/nonexistent/plan.md")).toThrow();
  });

  it("无效 YAML 抛 PlanFormatError", () => {
    const filePath = writeTmpPlan(`---
name: [invalid yaml
---
`);
    expect(() => PlanParser.parse(filePath)).toThrow(PlanFormatError);
  });

  it("task 为非对象时抛 PlanFormatError", () => {
    const filePath = writeTmpPlan(`---
name: bad-task
tasks:
  - "string not object"
---
`);
    expect(() => PlanParser.parse(filePath)).toThrow(PlanFormatError);
  });
});

// === PlanParser.fromPrdJson ===

describe("PlanParser.fromPrdJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const validPrd = {
    project: "test-feature",
    userStories: [
      {
        id: "US-001",
        title: "Story title",
        description: "As a developer, I want this feature",
        acceptanceCriteria: ["Typecheck passes", "Works correctly"],
      },
      {
        id: "US-002",
        title: "Another story",
        description: "As a user, I want that",
      },
    ],
    taskSplit: [
      {
        id: "LMR-001",
        title: "Task one",
        userStory: "US-001",
        depends: [],
      },
      {
        id: "LMR-002",
        title: "Task two",
        userStory: "US-002",
        depends: ["LMR-001"],
      },
    ],
  };

  function writeTmpPrd(data: object): string {
    const filePath = path.join(tmpDir, "prd.json");
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
  }

  it("解析有效的 prd.json", () => {
    const filePath = writeTmpPrd(validPrd);
    const spec = PlanParser.fromPrdJson(filePath);
    expect(spec.name).toBe("test-feature");
    expect(spec.tasks).toHaveLength(2);
    expect(spec.tasks[0].id).toBe("LMR-001");
    expect(spec.tasks[0].prompt).toContain("As a developer, I want this feature");
    expect(spec.tasks[0].prompt).toContain("Acceptance Criteria:");
    expect(spec.tasks[0].prompt).toContain("Typecheck passes");
    expect(spec.tasks[0].dependsOn).toEqual([]);
    expect(spec.tasks[1].id).toBe("LMR-002");
    expect(spec.tasks[1].prompt).toContain("As a user, I want that");
    expect(spec.tasks[1].dependsOn).toEqual(["LMR-001"]);
  });

  it("userStory description 为空时回退到 title", () => {
    const prd = {
      project: "fallback-test",
      userStories: [
        { id: "US-001", title: "Story Title", description: "" },
      ],
      taskSplit: [
        { id: "T-001", title: "Task Title", userStory: "US-001", depends: [] },
      ],
    };
    const filePath = writeTmpPrd(prd);
    const spec = PlanParser.fromPrdJson(filePath);
    expect(spec.tasks[0].prompt).toContain("Story Title");
  });

  it("userStory 引用不存在时回退到 task id", () => {
    const prd = {
      project: "missing-ref",
      userStories: [],
      taskSplit: [
        { id: "T-001", title: "Fallback Title", userStory: "US-999", depends: [] },
      ],
    };
    const filePath = writeTmpPrd(prd);
    const spec = PlanParser.fromPrdJson(filePath);
    expect(spec.tasks[0].prompt).toContain("Task T-001");
  });

  it("自定义 maxConcurrent", () => {
    const filePath = writeTmpPrd(validPrd);
    const spec = PlanParser.fromPrdJson(filePath, 3);
    expect(spec.maxConcurrent).toBe(3);
  });

  it("默认 maxConcurrent 为 5", () => {
    const filePath = writeTmpPrd(validPrd);
    const spec = PlanParser.fromPrdJson(filePath);
    expect(spec.maxConcurrent).toBe(5);
  });

  it("depends 缺失时默认空数组", () => {
    const prd = {
      project: "no-depends",
      userStories: [],
      taskSplit: [{ id: "T-001", title: "Task", userStory: "US-001" }],
    };
    const filePath = writeTmpPrd(prd);
    const spec = PlanParser.fromPrdJson(filePath);
    expect(spec.tasks[0].dependsOn).toEqual([]);
  });

  it("缺失 project 抛 PlanFormatError", () => {
    const prd = { userStories: [], taskSplit: [] };
    const filePath = writeTmpPrd(prd);
    expect(() => PlanParser.fromPrdJson(filePath)).toThrow(PlanFormatError);
  });

  it("缺失 taskSplit 抛 PlanFormatError", () => {
    const prd = { project: "x", userStories: [] };
    const filePath = writeTmpPrd(prd);
    expect(() => PlanParser.fromPrdJson(filePath)).toThrow(PlanFormatError);
  });

  it("文件不存在时抛 ENOENT", () => {
    expect(() =>
      PlanParser.fromPrdJson("/nonexistent/prd.json"),
    ).toThrow();
  });

  it("无效 JSON 抛 PlanFormatError", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{invalid json");
    expect(() => PlanParser.fromPrdJson(filePath)).toThrow(PlanFormatError);
  });

  it("task 为非对象时抛 PlanFormatError", () => {
    const prd = {
      project: "bad-tasks",
      userStories: [],
      taskSplit: ["string not object"],
    };
    const filePath = writeTmpPrd(prd);
    expect(() => PlanParser.fromPrdJson(filePath)).toThrow(PlanFormatError);
  });

  it("用项目 prd.json 验证端到端解析", () => {
    const projectPrdPath = path.resolve(
      import.meta.dirname ?? ".",
      "../tasks/prd.json",
    );
    if (!fs.existsSync(projectPrdPath)) return;
    const spec = PlanParser.fromPrdJson(projectPrdPath);
    expect(spec.name).toBe("loomer-v01");
    expect(spec.tasks.length).toBeGreaterThan(0);
    // 验证 DAG 合法
    expect(() => DAGValidator.validate(spec)).not.toThrow();
  });
});
