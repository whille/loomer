import type { LoomerConfig } from "./config.js";
export interface Workspace {
    name: string;
    path: string;
    branch: string;
}
export declare class WorkspaceManager {
    private readonly repoPath;
    constructor(_config: LoomerConfig, root?: string);
    create(name: string, baseBranch?: string): Workspace;
    remove(name: string): void;
    listAll(): Workspace[];
    exists(name: string): boolean;
    private detectBaseBranch;
}
//# sourceMappingURL=workspace.d.ts.map