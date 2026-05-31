import fs from "node:fs";
import yaml from "js-yaml";
import { DAGValidationError, PlanFormatError } from "./errors.js";
import { Status } from "./status.js";

// === 类型定义 ===

export interface TaskSpec {
  id: string;
  prompt: string;
  dependsOn: string[];
}

export interface PlanSpec {
  name: string;
  maxConcurrent: number;
  tasks: TaskSpec[];
}

export interface IPlanContext {
  registerAgent(
    name: string,
    prompt: string,
    dependsOn: string[],
    plan: string,
  ): void;
  launchAgent(name: string): void;
  rejectAgent(name: string): void;
  getAgentStatus(name: string): string | null;
  getRunningCount(): number;
}

// === PlanParser ===

export const PlanParser = {
  parse(path: string): PlanSpec {
    const content = fs.readFileSync(path, "utf-8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      throw new PlanFormatError("No YAML frontmatter found in plan file");
    }

    let parsed: Record<string, unknown> | null;
    try {
      parsed = yaml.load(match[1]) as Record<string, unknown> | null;
    } catch (e) {
      throw new PlanFormatError(
        `Invalid YAML in plan file: ${(e as Error).message}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new PlanFormatError("Invalid YAML frontmatter: expected object");
    }

    const name = parsed.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new PlanFormatError(
        "Missing or invalid 'name' in plan frontmatter",
      );
    }

    const maxConcurrent =
      typeof parsed.maxConcurrent === "number" ? parsed.maxConcurrent : 5;

    const tasksArr = parsed.tasks;
    if (!Array.isArray(tasksArr)) {
      throw new PlanFormatError(
        "Missing or invalid 'tasks' in plan frontmatter",
      );
    }

    const tasks: TaskSpec[] = tasksArr.map((t: unknown, i: number) => {
      if (typeof t !== "object" || t === null || Array.isArray(t)) {
        throw new PlanFormatError(`Task at index ${i}: expected object`);
      }
      const task = t as Record<string, unknown>;
      if (typeof task?.id !== "string" || task.id.length === 0) {
        throw new PlanFormatError(
          `Task at index ${i}: missing or invalid 'id'`,
        );
      }
      if (typeof task?.prompt !== "string") {
        throw new PlanFormatError(
          `Task '${task.id}': missing or invalid 'prompt'`,
        );
      }
      return {
        id: task.id,
        prompt: task.prompt,
        dependsOn: Array.isArray(task.dependsOn)
          ? (task.dependsOn as string[])
          : [],
      };
    });

    return { name, maxConcurrent, tasks };
  },

  fromPrdJson(path: string, maxConcurrent?: number): PlanSpec {
    const content = fs.readFileSync(path, "utf-8");
    let prd: Record<string, unknown>;
    try {
      prd = JSON.parse(content) as Record<string, unknown>;
    } catch (e) {
      throw new PlanFormatError(
        `Invalid JSON in prd.json: ${(e as Error).message}`,
      );
    }

    const name = prd.project;
    if (typeof name !== "string" || name.length === 0) {
      throw new PlanFormatError("Missing or invalid 'project' in prd.json");
    }

    const storyMap = new Map<string, { description: string; title: string }>();
    if (Array.isArray(prd.userStories)) {
      for (const s of prd.userStories as Record<string, unknown>[]) {
        if (typeof s.id === "string") {
          storyMap.set(s.id, {
            description: typeof s.description === "string" ? s.description : "",
            title: typeof s.title === "string" ? s.title : "",
          });
        }
      }
    }

    const tasksArr = prd.taskSplit;
    if (!Array.isArray(tasksArr)) {
      throw new PlanFormatError("Missing or invalid 'taskSplit' in prd.json");
    }

    const tasks: TaskSpec[] = tasksArr.map((t: unknown, i: number) => {
      const task = t as Record<string, unknown>;
      if (typeof task?.id !== "string" || task.id.length === 0) {
        throw new PlanFormatError(
          `Task at index ${i}: missing or invalid 'id'`,
        );
      }

      let prompt = typeof task.title === "string" ? task.title : "";
      if (typeof task.userStory === "string") {
        const story = storyMap.get(task.userStory);
        if (story && story.description.length > 0) {
          prompt = story.description;
        }
      }

      return {
        id: task.id,
        prompt,
        dependsOn: Array.isArray(task.depends)
          ? (task.depends as string[])
          : [],
      };
    });

    return {
      name,
      maxConcurrent: maxConcurrent ?? 5,
      tasks,
    };
  },
};

// === DAGValidator ===

export const DAGValidator = {
  validate(spec: PlanSpec): void {
    const tasks = spec.tasks;

    // Rule 1: ID 合法
    for (const task of tasks) {
      if (!/^[a-zA-Z0-9_-]+$/.test(task.id)) {
        throw new PlanFormatError(
          `Invalid task ID '${task.id}': must match ^[a-zA-Z0-9_-]+$`,
        );
      }
      if (task.id.length > 64) {
        throw new PlanFormatError(
          `Invalid task ID '${task.id}': must be ≤ 64 characters`,
        );
      }
    }

    // Rule 2: 无重复 ID
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.id)) {
        throw new PlanFormatError(`Duplicate task ID: '${task.id}'`);
      }
      seen.add(task.id);
    }

    // Rule 3: 无缺失引用
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (!seen.has(dep)) {
          throw new PlanFormatError(
            `Task '${task.id}' depends on unknown task '${dep}'`,
          );
        }
      }
    }

    // Rule 4: 无环（Kahn 算法）
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const task of tasks) {
      inDegree.set(task.id, task.dependsOn.length);
      adj.set(task.id, []);
    }

    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        adj.get(dep)?.push(task.id);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      processed++;
      const dependents = adj.get(current) ?? [];
      for (const dependent of dependents) {
        const prevDeg = inDegree.get(dependent);
        if (prevDeg === undefined) continue;
        const newDeg = prevDeg - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          queue.push(dependent);
        }
      }
    }

    if (processed < tasks.length) {
      throw new DAGValidationError("DAG contains a cycle");
    }
  },
};

// === PlanExecutor ===

const TERMINAL_STATUSES = new Set<string>([
  Status.DONE,
  Status.ACCEPTED,
  Status.REJECTED,
  Status.CRASHED,
  Status.CONFLICTED,
  Status.STALE,
]);

export class PlanExecutor {
  private readonly ctx: IPlanContext;
  private readonly spec: PlanSpec;
  private readonly taskIds: string[];

  constructor(ctx: IPlanContext, spec: PlanSpec) {
    this.ctx = ctx;
    this.spec = spec;
    this.taskIds = spec.tasks.map((t) => t.id);
  }

  registerTasks(): string[] {
    for (const task of this.spec.tasks) {
      this.ctx.registerAgent(
        task.id,
        task.prompt,
        task.dependsOn,
        this.spec.name,
      );
    }
    return this._checkAndStartPending();
  }

  onTaskDone(_taskId: string): string[] {
    return this._checkAndStartPending();
  }

  isPlanComplete(): boolean {
    for (const id of this.taskIds) {
      const status = this.ctx.getAgentStatus(id);
      if (status === null || !TERMINAL_STATUSES.has(status)) {
        return false;
      }
    }
    return true;
  }

  getProgress(): {
    plan: string;
    total: number;
    done: number;
    running: number;
    pending: number;
    crashed: number;
    conflicted: number;
    stale: number;
    review: number;
  } {
    let done = 0;
    let running = 0;
    let pending = 0;
    let crashed = 0;
    let conflicted = 0;
    let stale = 0;
    let review = 0;

    for (const id of this.taskIds) {
      const status = this.ctx.getAgentStatus(id) ?? "PENDING";
      switch (status) {
        case Status.DONE:
        case Status.ACCEPTED:
          done++;
          break;
        case Status.RUNNING:
          running++;
          break;
        case Status.PENDING:
          pending++;
          break;
        case Status.CRASHED:
          crashed++;
          break;
        case Status.CONFLICTED:
          conflicted++;
          break;
        case Status.STALE:
          stale++;
          break;
        case Status.REVIEW:
        case Status.REJECTED:
          review++;
          break;
      }
    }

    return {
      plan: this.spec.name,
      total: this.taskIds.length,
      done,
      running,
      pending,
      crashed,
      conflicted,
      stale,
      review,
    };
  }

  private _checkAndStartPending(_triggerTaskId?: string): string[] {
    const started: string[] = [];
    let changed = true;

    // 固定点迭代：级联 REJECTED 可能多层级传播，需重复遍历直到无新变化
    while (changed) {
      changed = false;

      for (const task of this.spec.tasks) {
        const status = this.ctx.getAgentStatus(task.id);
        if (status !== Status.PENDING) continue;

        let anyRejected = false;
        let allSatisfied = true;

        for (const dep of task.dependsOn) {
          const depStatus = this.ctx.getAgentStatus(dep);
          if (depStatus === Status.REJECTED) {
            anyRejected = true;
            break;
          }
          if (depStatus !== Status.DONE && depStatus !== Status.ACCEPTED) {
            allSatisfied = false;
            break;
          }
        }

        if (anyRejected) {
          this.ctx.rejectAgent(task.id);
          changed = true;
          continue;
        }

        if (
          allSatisfied &&
          this.ctx.getRunningCount() < this.spec.maxConcurrent
        ) {
          this.ctx.launchAgent(task.id);
          started.push(task.id);
          changed = true;
        }
      }
    }

    return started;
  }
}
