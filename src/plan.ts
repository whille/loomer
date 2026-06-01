import fs from "node:fs";
import yaml from "js-yaml";
import { DAGValidationError, PlanFormatError } from "./errors.js";
import type { LoomerAppLike } from "./types/web.js";
import type { PlanProgress } from "./types/web.js";

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

// === PlanParser（函数导出，避免 noStaticOnlyClass）===

function fromData(data: Record<string, unknown>): PlanSpec {
  if (!data.name || typeof data.name !== "string") {
    throw new PlanFormatError("Missing or invalid 'name' field");
  }
  if (!Array.isArray(data.tasks)) {
    throw new PlanFormatError("Missing or invalid 'tasks' field");
  }

  const rawTasks = data.tasks as Array<Record<string, unknown>>;

  for (const t of rawTasks) {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      throw new PlanFormatError("Each task must be an object");
    }
    if (!t.id || typeof t.id !== "string") {
      throw new PlanFormatError("Task missing required 'id' field");
    }
    if (!t.prompt || typeof t.prompt !== "string") {
      throw new PlanFormatError(`Task "${t.id as string}" missing required 'prompt' field`);
    }
  }

  return {
    name: data.name as string,
    maxConcurrent: (data.maxConcurrent as number) ?? 5,
    tasks: rawTasks.map((t) => ({
      id: t.id as string,
      prompt: t.prompt as string,
      dependsOn: (t.dependsOn as string[]) ?? [],
    })),
  };
}

export function parsePlan(path: string): PlanSpec {
  try {
    const content = fs.readFileSync(path, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) throw new PlanFormatError("No YAML frontmatter found");
    const data = yaml.load(match[1]) as Record<string, unknown>;
    return fromData(data);
  } catch (err) {
    if (err instanceof PlanFormatError || err instanceof DAGValidationError)
      throw err;
    throw new PlanFormatError(`Failed to parse plan.md: ${err}`);
  }
}

export function fromPrdJson(prdPath: string, maxConcurrent?: number): PlanSpec {
  try {
    const raw = fs.readFileSync(prdPath, "utf-8");
    const prd = JSON.parse(raw) as Record<string, unknown>;

    if (!prd.project || typeof prd.project !== "string") {
      throw new PlanFormatError("Missing or invalid 'project' field in prd.json");
    }

    const taskSplit = (prd.taskSplit ?? prd.tasks) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(taskSplit)) {
      throw new PlanFormatError("Missing or invalid 'taskSplit' or 'tasks' field in prd.json");
    }

    const userStories =
      (prd.userStories as Array<Record<string, string>>) ?? [];
    const storyMap = new Map(userStories.map((us) => [us.id, us]));

    for (const ts of taskSplit) {
      if (!ts || typeof ts !== "object" || Array.isArray(ts)) {
        throw new PlanFormatError("Each task in taskSplit must be an object");
      }
      if (!ts.id || typeof ts.id !== "string") {
        throw new PlanFormatError("Each task in taskSplit must have a string 'id' field");
      }
    }

    const tasks: TaskSpec[] = taskSplit.map((ts) => {
      const storyId = ts.userStory as string;
      const story = storyMap.get(storyId);
      const basePrompt =
        story?.description || story?.title || `Task ${ts.id as string}`;
      // 将 acceptance criteria 注入 prompt，避免 agent 因信息不足而交互式提问
      const criteria = (story?.acceptanceCriteria as unknown as string[]) ?? [];
      const promptParts = [basePrompt];
      if (criteria.length > 0) {
        promptParts.push("\n\nAcceptance Criteria:");
        for (const c of criteria) {
          promptParts.push(`- ${c}`);
        }
      }
      const hints = (story?.hints as unknown as string[]) ?? [];
      if (hints.length > 0) {
        promptParts.push("\n\nHints:");
        for (const h of hints) {
          promptParts.push(`- ${h}`);
        }
      }
      promptParts.push("\n\nImportant: Do NOT ask clarifying questions. Implement based on the criteria above. Commit all changes.");
      return {
        id: ts.id as string,
        prompt: promptParts.join(""),
        dependsOn: (ts.depends as string[]) ?? [],
      };
    });

    return {
      name: (prd.project as string) ?? "unnamed",
      maxConcurrent: maxConcurrent ?? 5,
      tasks,
    };
  } catch (err) {
    if (err instanceof PlanFormatError || err instanceof DAGValidationError)
      throw err;
    throw new PlanFormatError(`Failed to parse prd.json: ${err}`);
  }
}

// 兼容 api-spec 的 class 接口
export const PlanParser = { parse: parsePlan, fromPrdJson };

// === DAGValidator（函数导出）===

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

export function validateDag(spec: PlanSpec): void {
  const ids = new Set<string>();

  // 规则 1: ID 合法性（格式问题 → PlanFormatError）
  for (const task of spec.tasks) {
    if (!VALID_ID.test(task.id) || task.id.length > 64) {
      throw new PlanFormatError(
        `Invalid task ID: "${task.id}" (must match /^[a-zA-Z0-9_-]+$/, max 64 chars)`,
      );
    }
  }

  // 规则 2: 无重复（格式问题 → PlanFormatError）
  for (const task of spec.tasks) {
    if (ids.has(task.id)) {
      throw new PlanFormatError(`Duplicate task ID: "${task.id}"`);
    }
    ids.add(task.id);
  }

  // 规则 3: 无缺失引用（格式问题 → PlanFormatError）
  for (const task of spec.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new PlanFormatError(
          `Missing dependency: "${dep}" referenced by "${task.id}"`,
        );
      }
    }
  }

  // 规则 4: 无环（Kahn 算法拓扑排序）
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of spec.tasks) {
    inDegree.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }

  for (const task of spec.tasks) {
    for (const dep of task.dependsOn) {
      dependents.get(dep)?.push(task.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let sortedCount = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    sortedCount++;
    for (const dependent of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (sortedCount < spec.tasks.length) {
    throw new DAGValidationError("Dependency graph contains a cycle");
  }
}

export const DAGValidator = { validate: validateDag };

// === PlanExecutor ===

export class PlanExecutor {
  private readonly app: LoomerAppLike;
  private readonly spec: PlanSpec;
  private readonly taskStatus: Map<string, string> = new Map();

  constructor(app: LoomerAppLike, spec: PlanSpec) {
    this.app = app;
    this.spec = spec;
  }

  registerTasks(): void {
    for (const task of this.spec.tasks) {
      this.taskStatus.set(task.id, "PENDING");
    }
  }

  /** 启动所有依赖已满足的 PENDING 任务，受 maxConcurrent 限制 */
  launchReady(): string[] {
    const started: string[] = [];
    const runningCount = this.countByStatus("RUNNING");

    for (const task of this.spec.tasks) {
      if (this.taskStatus.get(task.id) !== "PENDING") continue;
      if (runningCount + started.length >= this.spec.maxConcurrent) break;

      const allDepsSatisfied = task.dependsOn.every((dep) => {
        const status = this.taskStatus.get(dep);
        return status === "DONE" || status === "ACCEPTED";
      });

      if (allDepsSatisfied) {
        this.taskStatus.set(task.id, "RUNNING");
        started.push(task.id);
        this.app.start(task.id, task.prompt);
      }
    }

    return started;
  }

  onTaskDone(taskId: string): string[] {
    if (!this.taskStatus.has(taskId)) return [];
    this.taskStatus.set(taskId, "DONE");
    return this.propagateAndLaunch();
  }

  onTaskAccepted(taskId: string): string[] {
    if (!this.taskStatus.has(taskId)) return [];
    this.taskStatus.set(taskId, "ACCEPTED");
    return this.propagateAndLaunch();
  }

  onTaskRejected(taskId: string): string[] {
    if (!this.taskStatus.has(taskId)) return [];
    this.taskStatus.set(taskId, "REJECTED");
    return this.propagateAndLaunch();
  }

  onTaskCrashed(taskId: string): string[] {
    if (!this.taskStatus.has(taskId)) return [];
    this.taskStatus.set(taskId, "CRASHED");
    return this.propagateAndLaunch();
  }

  onTaskConflicted(taskId: string): string[] {
    if (!this.taskStatus.has(taskId)) return [];
    this.taskStatus.set(taskId, "CONFLICTED");
    return this.propagateAndLaunch();
  }

  onTaskStale(taskId: string): string[] {
    if (!this.taskStatus.has(taskId)) return [];
    this.taskStatus.set(taskId, "STALE");
    return this.propagateAndLaunch();
  }

  onTaskReview(taskId: string): string[] {
    if (!this.taskStatus.has(taskId)) return [];
    this.taskStatus.set(taskId, "REVIEW");
    return this.propagateAndLaunch();
  }

  private propagateAndLaunch(): string[] {
    // 级联拒绝：固定点迭代
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.spec.tasks) {
        if (this.taskStatus.get(task.id) !== "PENDING") continue;
        for (const dep of task.dependsOn) {
          if (this.taskStatus.get(dep) === "REJECTED") {
            this.taskStatus.set(task.id, "REJECTED");
            this.app.reject(task.id);
            changed = true;
            break;
          }
        }
      }
    }

    return this.launchReady();
  }

  private countByStatus(status: string): number {
    let count = 0;
    for (const s of this.taskStatus.values()) {
      if (s === status) count++;
    }
    return count;
  }

  isPlanComplete(): boolean {
    for (const task of this.spec.tasks) {
      const status = this.taskStatus.get(task.id);
      if (
        status !== "DONE" &&
        status !== "ACCEPTED" &&
        status !== "REJECTED" &&
        status !== "CRASHED" &&
        status !== "CONFLICTED" &&
        status !== "STALE" &&
        status !== "REVIEW"
      ) {
        return false;
      }
    }
    return true;
  }

  getProgress(): PlanProgress {
    let done = 0;
    let running = 0;
    let pending = 0;
    let crashed = 0;
    let conflicted = 0;
    let stale = 0;
    let review = 0;

    for (const task of this.spec.tasks) {
      const status = this.app.getTaskStatus(task.id) ?? this.taskStatus.get(task.id) ?? "PENDING";
      switch (status) {
        case "DONE":
        case "ACCEPTED":
          done++;
          break;
        case "RUNNING":
          running++;
          break;
        case "PENDING":
          pending++;
          break;
        case "CRASHED":
          crashed++;
          break;
        case "CONFLICTED":
          conflicted++;
          break;
        case "STALE":
          stale++;
          break;
        case "REVIEW":
        case "REJECTED":
          review++;
          break;
      }
    }

    return {
      plan: this.spec.name,
      total: this.spec.tasks.length,
      done,
      running,
      pending,
      crashed,
      conflicted,
      stale,
      review,
    };
  }
}
