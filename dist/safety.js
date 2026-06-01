import { execFileSync } from "node:child_process";
import { InvalidNameError } from "./errors.js";
export var RiskLevel;
(function (RiskLevel) {
    RiskLevel["LOW"] = "LOW";
    RiskLevel["HIGH"] = "HIGH";
})(RiskLevel || (RiskLevel = {}));
export class RiskSignal {
    name;
    level;
    detail;
    constructor(name, level, detail) {
        this.name = name;
        this.level = level;
        this.detail = detail;
    }
    toDict() {
        return { name: this.name, level: this.level, detail: this.detail };
    }
}
export class RiskAssessment {
    level;
    signals;
    constructor(level, signals) {
        this.level = level;
        this.signals = signals;
    }
    toDict() {
        return {
            level: this.level,
            signals: this.signals.map((s) => s.toDict()),
        };
    }
}
export class SafetyChecks {
    repoPath;
    constructor(repoPath = process.cwd()) {
        this.repoPath = repoPath;
    }
    checkGitClean() {
        const output = execFileSync("git", ["status", "--porcelain"], {
            cwd: this.repoPath,
            encoding: "utf-8",
        });
        return output.trim() === "";
    }
    checkGitignore(dir) {
        try {
            execFileSync("git", ["check-ignore", "-q", dir], {
                cwd: this.repoPath,
                encoding: "utf-8",
            });
            return true;
        }
        catch {
            return false;
        }
    }
    checkBranchExists(name) {
        const output = execFileSync("git", ["branch", "--list", name], {
            cwd: this.repoPath,
            encoding: "utf-8",
        });
        return output.trim().length > 0;
    }
    static validateName(name) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            throw new InvalidNameError(`Invalid name "${name}": must match /^[a-zA-Z0-9_-]+$/`);
        }
        if (name.length > 64) {
            throw new InvalidNameError(`Invalid name "${name}": must be ≤ 64 characters, got ${name.length}`);
        }
    }
    assessRisk(name, worktreePath, mergeStrategy, rules, baseBranch) {
        // merge_strategy 短路
        if (mergeStrategy === "always") {
            return new RiskAssessment(RiskLevel.HIGH, [
                new RiskSignal("merge_strategy", RiskLevel.HIGH, "merge_strategy=always, all changes require review"),
            ]);
        }
        if (mergeStrategy === "never") {
            return new RiskAssessment(RiskLevel.LOW, [
                new RiskSignal("merge_strategy", RiskLevel.LOW, "merge_strategy=never, all changes auto-merge"),
            ]);
        }
        const base = baseBranch || "master";
        // 信号 1+3+4+6 共享 name-status 输出
        const diffNameStatus = execFileSync("git", ["diff", "--name-status", `${base}...HEAD`], {
            cwd: worktreePath,
            encoding: "utf-8",
        }).trim();
        const statusLines = diffNameStatus
            ? diffNameStatus.split("\n").filter(Boolean)
            : [];
        // 纯新增判断：所有变更都是 Added → 项目初始搭建，不触发 new_files/test 信号
        const isAllNewFiles = statusLines.length > 0
            && statusLines.every((l) => l.startsWith("A\t"));
        // 信号 1: file_count（纯新增一律 LOW）
        const files = statusLines
            .map((l) => l.split("\t").pop() || "")
            .filter(Boolean);
        const fileCount = files.length;
        const fileCountLevel = isAllNewFiles
            ? RiskLevel.LOW
            : fileCount > rules.maxFiles ? RiskLevel.HIGH : RiskLevel.LOW;
        // 信号 2: line_count（纯新增一律 LOW）
        const shortstat = execFileSync("git", ["diff", "--shortstat", `${base}...HEAD`], {
            cwd: worktreePath,
            encoding: "utf-8",
        }).trim();
        const insMatch = shortstat.match(/(\d+) insertion/);
        const delMatch = shortstat.match(/(\d+) deletion/);
        const insertions = insMatch ? Number.parseInt(insMatch[1], 10) : 0;
        const deletions = delMatch ? Number.parseInt(delMatch[1], 10) : 0;
        const totalLines = insertions + deletions;
        const lineCountLevel = isAllNewFiles
            ? RiskLevel.LOW
            : totalLines > rules.maxLines ? RiskLevel.HIGH : RiskLevel.LOW;
        // 信号 3: new_files（纯新增一律 LOW）
        const hasNewFiles = statusLines.some((l) => l.startsWith("A\t"));
        const newFilesLevel = hasNewFiles && !isAllNewFiles ? RiskLevel.HIGH : RiskLevel.LOW;
        // 信号 4: public_modules（纯新增一律 LOW）
        const hasPublicModules = files.some((filepath) => {
            const parts = filepath.split("/");
            return parts.slice(0, -1).some((p) => ["lib", "core", "src"].includes(p));
        });
        const publicModulesLevel = hasPublicModules && !isAllNewFiles
            ? RiskLevel.HIGH
            : RiskLevel.LOW;
        // 信号 5: conflict（试合并 + 回滚）
        let hasConflict = false;
        try {
            execFileSync("git", ["merge", "--no-commit", "--no-ff", base], {
                cwd: worktreePath,
                encoding: "utf-8",
            });
            // 合并成功，检查是否有未合并路径（冲突）
            const statusOutput = execFileSync("git", ["ls-files", "--unmerged"], {
                cwd: worktreePath,
                encoding: "utf-8",
            });
            hasConflict = statusOutput.trim().length > 0;
            // 清理：回滚试合并
            try {
                execFileSync("git", ["merge", "--abort"], {
                    cwd: worktreePath,
                    encoding: "utf-8",
                });
            }
            catch {
                // "Already up to date" 时无 MERGE_HEAD 可 abort，属正常情况
            }
        }
        catch {
            // 合并命令失败（通常意味着冲突）
            hasConflict = true;
            try {
                execFileSync("git", ["merge", "--abort"], {
                    cwd: worktreePath,
                    encoding: "utf-8",
                });
            }
            catch {
                // 回滚失败，尽力清理
            }
        }
        const conflictLevel = hasConflict
            ? (rules.conflict === "auto" ? RiskLevel.LOW : RiskLevel.HIGH)
            : RiskLevel.LOW;
        // 信号 6: test（纯新增一律 LOW；修改已有文件但无测试变更仍为 HIGH）
        const hasTestFiles = files.some((filepath) => {
            const parts = filepath.split("/");
            const filename = parts[parts.length - 1];
            const inTestDir = parts.some((p) => p === "tests" || p === "__tests__");
            const isTestFile = filename.endsWith(".test.ts") || filename.endsWith(".spec.ts");
            return inTestDir || isTestFile;
        });
        const testLevel = files.length > 0 && !hasTestFiles && !isAllNewFiles ? RiskLevel.HIGH : RiskLevel.LOW;
        // 汇总
        const signals = [
            new RiskSignal("file_count", fileCountLevel, `${fileCount} files changed (threshold: ${rules.maxFiles})`),
            new RiskSignal("line_count", lineCountLevel, `${totalLines} lines changed (threshold: ${rules.maxLines})`),
            new RiskSignal("new_files", newFilesLevel, hasNewFiles ? "new files added" : "no new files"),
            new RiskSignal("public_modules", publicModulesLevel, hasPublicModules
                ? "modified public modules"
                : "no public module changes"),
            new RiskSignal("conflict", conflictLevel, hasConflict ? "merge conflict detected" : "no conflict"),
            new RiskSignal("test", testLevel, files.length > 0
                ? hasTestFiles
                    ? "test files modified"
                    : "no test files modified"
                : "no changes"),
        ];
        const overallLevel = signals.some((s) => s.level === RiskLevel.HIGH)
            ? RiskLevel.HIGH
            : RiskLevel.LOW;
        return new RiskAssessment(overallLevel, signals);
    }
}
//# sourceMappingURL=safety.js.map