export declare enum Status {
    PENDING = "PENDING",
    RUNNING = "RUNNING",
    DONE = "DONE",
    CRASHED = "CRASHED",
    CONFLICTED = "CONFLICTED",
    STALE = "STALE",
    REVIEW = "REVIEW",
    ACCEPTED = "ACCEPTED",
    REJECTED = "REJECTED"
}
export interface IAgentData {
    name: string;
    status: string;
    worktree: string;
    prompt: string | null;
    started_at: number | null;
    pid: number | null;
    exit_code: number | null;
    risk_assessment: string | null;
    pr_url: string | null;
    archived: number;
    depends_on: string | null;
    plan: string | null;
}
export interface IStateStore {
    getAgent(name: string): IAgentData | null;
    getAllAgents(): IAgentData[];
    updateAgentStatus(name: string, status: string): void;
}
export interface IProcessManager {
    isAlive(name: string): boolean;
    getPid(name: string): number | null;
    getRecentOutput(name: string): string;
    hasExited(name: string): boolean;
    getExitCode(name: string): number | null;
}
export declare class StatusDetector {
    private readonly state;
    private readonly process;
    private readonly timeoutMinutes;
    private transitionCallback;
    constructor(state: IStateStore, process: IProcessManager, timeoutMinutes: number);
    setTransitionCallback(cb: (name: string, status: Status) => void): void;
    getStatus(name: string): Status;
    getRecentOutput(name: string): string;
    getDiff(name: string, mode?: "stat" | "full"): string;
    private _detectRunningStatus;
    private _updateAndFire;
    hasUncommittedChanges(worktreePath: string): boolean;
    autoCommit(name: string, worktreePath: string): void;
}
//# sourceMappingURL=status.d.ts.map