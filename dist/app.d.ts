import type http from "node:http";
import type { LoomerConfig } from "./config.js";
import { ProcessManager } from "./process.js";
import { StateStore } from "./state.js";
import { type IStateStore, Status } from "./status.js";
import type { AgentInfo, DagData, PlanProgress, PlanResult } from "./types/web.js";
import { WorkspaceManager } from "./workspace.js";
export declare class LoomerApp {
    private readonly config;
    private readonly state;
    private readonly processManager;
    private readonly workspaceManager;
    private readonly safety;
    private readonly statusDetector;
    private readonly repoPath;
    private planExecutor;
    private server;
    private serverPort;
    private pollTimer;
    private _mergeLocked;
    private _mergeQueue;
    /** 从 config 创建完整 LoomerApp（CLI 入口用） */
    static create(config: LoomerConfig, repoPath?: string): LoomerApp;
    constructor(config: LoomerConfig, state: StateStore & {
        asIStateStore?: () => IStateStore;
    }, processManager: ProcessManager, workspaceManager: WorkspaceManager, iStateStore?: IStateStore, repoPath?: string);
    onTransition(name: string, status: Status): void;
    start(name: string, prompt: string): void;
    done(name: string): void;
    accept(name: string): void;
    reject(name: string): void;
    kill(name: string, clean?: boolean): void;
    retry(name: string): void;
    getTaskStatus(id: string): string | undefined;
    status(): AgentInfo[];
    log(name: string): string;
    diff(name: string, mode?: "stat" | "full"): string;
    runPlan(planPath?: string, prdPath?: string, port?: number): PlanResult;
    planStatus(): PlanProgress | null;
    planDag(): DagData | null;
    startServer(port?: number): http.Server | null;
    stopServer(): void;
    getServerPort(): number | null;
    startStatusPolling(): void;
    private _autoStopWebIfDone;
    shutdown(): void;
    _mergeAgent(name: string, worktreePath: string): void;
    private _doMergeAgent;
    _autoResolveConflicts(mergeDir: string): boolean;
    _extractConflictSides(content: string): {
        ours: string | null;
        theirs: string | null;
    };
    _createPr(name: string): string | null;
    _triggerDepResolution(name: string): void;
    _countPlanProgress(): PlanProgress | null;
    private agentToInfo;
}
//# sourceMappingURL=app.d.ts.map