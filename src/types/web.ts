export interface LoomerConfig {
  baseBranch: string;
  claudePath: string;
  claudeArgs: string[];
  defaultPort: number;
  defaultTimeoutMinutes: number;
  maxConcurrent: number;
  stateDir: string;
  skillPrefix: boolean;
  mergeStrategy: "auto" | "always" | "never";
  createPr: boolean;
  autoMergeRules: {
    maxFiles: number;
    maxLines: number;
    conflict: "review" | "auto";
    testFail: "review" | "auto";
  };
}

export interface RiskSignalData {
  name: string;
  level: "LOW" | "HIGH";
  detail: string;
}

export interface RiskAssessmentData {
  level: "LOW" | "HIGH";
  signals: RiskSignalData[];
}

export interface AgentInfo {
  name: string;
  status: string;
  branch?: string;
  prompt?: string;
  worktree?: string;
  started_at?: number;
  pid?: number | null;
  exit_code?: number | null;
  risk_assessment?: RiskAssessmentData | null;
  last_output?: string;
  pr_url?: string | null;
  archived?: boolean;
  depends_on?: string[];
  plan?: string | null;
}

export interface PlanProgress {
  plan: string;
  total: number;
  done: number;
  running: number;
  pending: number;
  crashed: number;
  conflicted: number;
  stale: number;
  review: number;
}

export interface DagData {
  nodes: Array<{ id: string; status: string }>;
  edges: Array<{ from: string; to: string }>;
}

export interface PlanResult {
  name: string;
  taskCount: number;
}

export interface LoomerAppLike {
  start(name: string, prompt: string): void;
  done(name: string): void;
  accept(name: string): void;
  reject(name: string): void;
  kill(name: string, clean?: boolean): void;
  retry(name: string): void;
  status(): AgentInfo[];
  log(name: string, lines?: number): string;
  diff(name: string, mode?: string): string;
  runPlan(path?: string, prdPath?: string, port?: number): PlanResult;
  planStatus(): PlanProgress | null;
  planDag(): DagData | null;
  startServer(port?: number): unknown;
  stopServer(): void;
  getServerPort(): number | null;
  shutdown(): void;
}
