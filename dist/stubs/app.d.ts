import type { LoomerAppLike, AgentInfo, PlanProgress, DagData } from "../types/web.js";
export interface StubApp extends LoomerAppLike {
    agents: Map<string, AgentInfo>;
    planData: {
        progress: PlanProgress | null;
        dag: DagData | null;
    };
    reset(): void;
}
export declare function createStubApp(): StubApp;
//# sourceMappingURL=app.d.ts.map