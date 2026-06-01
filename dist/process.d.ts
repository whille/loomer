import type { LoomerConfig } from "./config.js";
import type { StateStore } from "./state.js";
export interface ProcessInfo {
    name: string;
    pid: number | null;
    alive: boolean;
}
export declare class ProcessManager {
    private readonly config;
    private readonly state;
    private readonly processes;
    constructor(config: LoomerConfig, state: StateStore);
    killAllProcessGroups(sig: string): void;
    start(name: string, worktreePath: string, prompt: string): void;
    stop(name: string): void;
    list(): string[];
    dispose(): void;
    isAlive(name: string): boolean;
    getPid(name: string): number | null;
    getRecentOutput(name: string): string;
    hasExited(name: string): boolean;
    getExitCode(name: string): number | null;
    listProcesses(): ProcessInfo[];
    static parseStreamJson(lines: string[]): string;
}
//# sourceMappingURL=process.d.ts.map