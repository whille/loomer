export interface AutoMergeRules {
    maxFiles: number;
    maxLines: number;
    conflict: "review" | "auto";
    testFail: "review" | "auto";
}
export interface LoomerConfigData {
    baseBranch: string;
    claudePath: string;
    claudeArgs: string[];
    defaultPort: number;
    defaultTimeoutMinutes: number;
    maxConcurrent: number;
    stateDir: string;
    mergeStrategy: "auto" | "always" | "never";
    createPr: boolean;
    autoMergeRules: AutoMergeRules;
}
export declare const MAX_OUTPUT_CHARS = 50000;
export declare class LoomerConfig implements LoomerConfigData {
    baseBranch: string;
    claudePath: string;
    claudeArgs: string[];
    defaultPort: number;
    defaultTimeoutMinutes: number;
    maxConcurrent: number;
    stateDir: string;
    mergeStrategy: "auto" | "always" | "never";
    createPr: boolean;
    autoMergeRules: AutoMergeRules;
    /** ~ 展开后的绝对路径 */
    resolvedStateDir: string;
    constructor(data?: LoomerConfigData);
    /**
     * 三层覆盖加载：全局 ~/.loomer/config.json → 项目 .loomer.json → CLI overrides
     * 优先级：CLI > 项目 > 全局 > 内置默认
     * 未知 key 静默忽略
     */
    static load(configPath?: string, overrides?: Partial<LoomerConfigData>): LoomerConfig;
}
//# sourceMappingURL=config.d.ts.map