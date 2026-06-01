import type { LoomerConfig } from "./config.js";
import type { IStateStore } from "./status.js";
import type { RiskAssessmentData } from "./types/web.js";
export interface AgentData {
    name: string;
    status: string;
    branch: string | null;
    prompt: string | null;
    worktree: string | null;
    started_at: number | null;
    pid: number | null;
    exit_code: number | null;
    risk_assessment: RiskAssessmentData | null;
    last_output: string | null;
    pr_url: string | null;
    merge_commit_sha: string | null;
    archived: boolean;
    depends_on: string[];
    plan: string | null;
}
export interface PlanData {
    name: string;
    max_concurrent: number;
    tasks: Array<{
        id: string;
        prompt: string;
        depends_on: string[];
    }>;
    created_at: number;
}
export declare class StateStore {
    private readonly db;
    constructor(config: LoomerConfig, repoPath: string);
    close(): void;
    getAgent(name: string): AgentData | null;
    updateAgent(name: string, fields: Record<string, unknown>): void;
    updateAgentStatus(name: string, status: string): void;
    removeAgent(name: string): void;
    getPendingAgents(): AgentData[];
    getRunningCount(): number;
    getActiveAgents(): AgentData[];
    getArchivedAgents(): AgentData[];
    getAllAgents(): AgentData[];
    archiveAgent(name: string): void;
    getPlan(): PlanData | null;
    setPlan(plan: PlanData): void;
    clearPlan(): void;
    asIStateStore(): IStateStore;
    private agentToIAgentData;
    private agentToRow;
    private fieldsToRow;
}
//# sourceMappingURL=state.d.ts.map