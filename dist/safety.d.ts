import type { AutoMergeRules } from "./config.js";
export declare enum RiskLevel {
    LOW = "LOW",
    HIGH = "HIGH"
}
export declare class RiskSignal {
    name: string;
    level: RiskLevel;
    detail: string;
    constructor(name: string, level: RiskLevel, detail: string);
    toDict(): object;
}
export declare class RiskAssessment {
    level: RiskLevel;
    signals: RiskSignal[];
    constructor(level: RiskLevel, signals: RiskSignal[]);
    toDict(): object;
}
export declare class SafetyChecks {
    private repoPath;
    constructor(repoPath?: string);
    checkGitClean(): boolean;
    checkGitignore(dir: string): boolean;
    checkBranchExists(name: string): boolean;
    static validateName(name: string): void;
    assessRisk(name: string, worktreePath: string, mergeStrategy: string, rules: AutoMergeRules, baseBranch?: string): RiskAssessment;
}
//# sourceMappingURL=safety.d.ts.map