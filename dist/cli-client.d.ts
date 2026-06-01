import type { LoomerConfig } from "./config.js";
import type { AgentInfo, PlanProgress } from "./types/web.js";
export declare class CliError extends Error {
    readonly serverError: string | undefined;
    readonly statusCode: number;
    constructor(message: string, serverError?: string, statusCode?: number);
}
export declare class LoomerClient {
    private readonly baseUrl;
    private readonly config;
    constructor(config: LoomerConfig);
    isServerRunning(): Promise<boolean>;
    start(name: string, prompt: string): Promise<{
        ok: boolean;
    }>;
    done(name: string): Promise<{
        ok: boolean;
    }>;
    kill(name: string, clean?: boolean): Promise<{
        ok: boolean;
    }>;
    retry(name: string): Promise<{
        ok: boolean;
    }>;
    accept(name: string): Promise<{
        ok: boolean;
    }>;
    reject(name: string): Promise<{
        ok: boolean;
    }>;
    status(all?: boolean): Promise<AgentInfo[]>;
    log(name: string): Promise<string>;
    planStatus(): Promise<PlanProgress | null>;
    private get;
    post<T>(urlPath: string, body?: unknown): Promise<T>;
    private handleResponse;
    private getDbPath;
    private openDb;
    private offlineStatus;
    private offlineLog;
}
export declare function formatStatusTable(agents: AgentInfo[]): string;
export declare function formatPlanStatus(progress: PlanProgress | null): string;
//# sourceMappingURL=cli-client.d.ts.map