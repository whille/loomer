import type { LoomerAppLike } from "./types/web.js";
import type { PlanProgress } from "./types/web.js";
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
export declare function parsePlan(path: string): PlanSpec;
export declare function fromPrdJson(prdPath: string, maxConcurrent?: number): PlanSpec;
export declare const PlanParser: {
    parse: typeof parsePlan;
    fromPrdJson: typeof fromPrdJson;
};
export declare function validateDag(spec: PlanSpec): void;
export declare const DAGValidator: {
    validate: typeof validateDag;
};
export declare class PlanExecutor {
    private readonly app;
    private readonly spec;
    private readonly taskStatus;
    constructor(app: LoomerAppLike, spec: PlanSpec);
    registerTasks(): void;
    /** 启动所有依赖已满足的 PENDING 任务，受 maxConcurrent 限制 */
    launchReady(): string[];
    onTaskDone(taskId: string): string[];
    onTaskAccepted(taskId: string): string[];
    onTaskRejected(taskId: string): string[];
    onTaskCrashed(taskId: string): string[];
    onTaskConflicted(taskId: string): string[];
    onTaskStale(taskId: string): string[];
    onTaskReview(taskId: string): string[];
    private propagateAndLaunch;
    private countByStatus;
    isPlanComplete(): boolean;
    getProgress(): PlanProgress;
}
//# sourceMappingURL=plan.d.ts.map