import { execSync } from "node:child_process";
import type { AutoMergeRules } from "./config.js";
import { InvalidNameError } from "./errors.js";

export enum RiskLevel {
  LOW = "LOW",
  HIGH = "HIGH",
}

export class RiskSignal {
  name: string;
  level: RiskLevel;
  detail: string;

  constructor(name: string, level: RiskLevel, detail: string) {
    this.name = name;
    this.level = level;
    this.detail = detail;
  }

  toDict(): object {
    return { name: this.name, level: this.level, detail: this.detail };
  }
}

export class RiskAssessment {
  level: RiskLevel;
  signals: RiskSignal[];

  constructor(level: RiskLevel, signals: RiskSignal[]) {
    this.level = level;
    this.signals = signals;
  }

  toDict(): object {
    return {
      level: this.level,
      signals: this.signals.map((s) => s.toDict()),
    };
  }
}

export class SafetyChecks {
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
  }

  checkGitClean(): boolean {
    const output = execSync("git status --porcelain", {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return output.trim() === "";
  }

  checkGitignore(dir: string): boolean {
    try {
      execSync(`git check-ignore -q "${dir}"`, {
        cwd: this.repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  checkBranchExists(name: string): boolean {
    const output = execSync(`git branch --list "${name}"`, {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return output.trim().length > 0;
  }

  static validateName(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new InvalidNameError(
        `Invalid name "${name}": must match /^[a-zA-Z0-9_-]+$/`,
      );
    }
    if (name.length > 64) {
      throw new InvalidNameError(
        `Invalid name "${name}": must be ≤ 64 characters, got ${name.length}`,
      );
    }
  }

  assessRisk(
    name: string,
    worktreePath: string,
    mergeStrategy: string,
    rules: AutoMergeRules,
    baseBranch?: string,
  ): RiskAssessment {
    // merge_strategy 短路
    if (mergeStrategy === "always") {
      return new RiskAssessment(RiskLevel.HIGH, [
        new RiskSignal(
          "merge_strategy",
          RiskLevel.HIGH,
          "merge_strategy=always, all changes require review",
        ),
      ]);
    }
    if (mergeStrategy === "never") {
      return new RiskAssessment(RiskLevel.LOW, [
        new RiskSignal(
          "merge_strategy",
          RiskLevel.LOW,
          "merge_strategy=never, all changes auto-merge",
        ),
      ]);
    }

    const base = baseBranch || "master";

    // 信号 1+3+4+6 共享 name-status 输出
    const diffNameStatus = execSync(`git diff --name-status ${base}...HEAD`, {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();
    const statusLines = diffNameStatus
      ? diffNameStatus.split("\n").filter(Boolean)
      : [];

    // 信号 1: file_count
    const files = statusLines
      .map((l) => l.split("\t").pop() || "")
      .filter(Boolean);
    const fileCount = files.length;
    const fileCountLevel =
      fileCount > rules.maxFiles ? RiskLevel.HIGH : RiskLevel.LOW;

    // 信号 2: line_count
    const shortstat = execSync(`git diff --shortstat ${base}...HEAD`, {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();
    const insMatch = shortstat.match(/(\d+) insertion/);
    const delMatch = shortstat.match(/(\d+) deletion/);
    const insertions = insMatch ? Number.parseInt(insMatch[1], 10) : 0;
    const deletions = delMatch ? Number.parseInt(delMatch[1], 10) : 0;
    const totalLines = insertions + deletions;
    const lineCountLevel =
      totalLines > rules.maxLines ? RiskLevel.HIGH : RiskLevel.LOW;

    // 信号 3: new_files
    const hasNewFiles = statusLines.some((l) => l.startsWith("A\t"));
    const newFilesLevel = hasNewFiles ? RiskLevel.HIGH : RiskLevel.LOW;

    // 信号 4: public_modules（精确路径段匹配）
    const hasPublicModules = files.some((filepath) => {
      const parts = filepath.split("/");
      return parts.slice(0, -1).some((p) => ["lib", "core", "src"].includes(p));
    });
    const publicModulesLevel = hasPublicModules
      ? RiskLevel.HIGH
      : RiskLevel.LOW;

    // 信号 5: conflict（试合并 + 回滚）
    let hasConflict = false;
    try {
      const mergeOutput = execSync(`git merge --no-commit --no-ff ${base}`, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // 合并成功，检查是否有未合并路径（冲突）
      const statusOutput = execSync("git ls-files --unmerged", {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      hasConflict = statusOutput.trim().length > 0;
      // 清理：回滚试合并
      try {
        execSync("git merge --abort", {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // "Already up to date" 时无 MERGE_HEAD 可 abort，属正常情况
      }
    } catch {
      // 合并命令失败（通常意味着冲突）
      hasConflict = true;
      try {
        execSync("git merge --abort", {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // 回滚失败，尽力清理
      }
    }
    const conflictLevel = hasConflict ? RiskLevel.HIGH : RiskLevel.LOW;

    // 信号 6: test（TypeScript 适配：*.test.ts, *.spec.ts, tests/, __tests__/）
    const hasTestFiles = files.some((filepath) => {
      const parts = filepath.split("/");
      const filename = parts[parts.length - 1];
      const inTestDir = parts.some((p) => p === "tests" || p === "__tests__");
      const isTestFile =
        filename.endsWith(".test.ts") || filename.endsWith(".spec.ts");
      return inTestDir || isTestFile;
    });
    const testLevel =
      files.length > 0 && !hasTestFiles ? RiskLevel.HIGH : RiskLevel.LOW;

    // 汇总
    const signals = [
      new RiskSignal(
        "file_count",
        fileCountLevel,
        `${fileCount} files changed (threshold: ${rules.maxFiles})`,
      ),
      new RiskSignal(
        "line_count",
        lineCountLevel,
        `${totalLines} lines changed (threshold: ${rules.maxLines})`,
      ),
      new RiskSignal(
        "new_files",
        newFilesLevel,
        hasNewFiles ? "new files added" : "no new files",
      ),
      new RiskSignal(
        "public_modules",
        publicModulesLevel,
        hasPublicModules
          ? "modified public modules"
          : "no public module changes",
      ),
      new RiskSignal(
        "conflict",
        conflictLevel,
        hasConflict ? "merge conflict detected" : "no conflict",
      ),
      new RiskSignal(
        "test",
        testLevel,
        files.length > 0
          ? hasTestFiles
            ? "test files modified"
            : "no test files modified"
          : "no changes",
      ),
    ];

    const overallLevel = signals.some((s) => s.level === RiskLevel.HIGH)
      ? RiskLevel.HIGH
      : RiskLevel.LOW;

    return new RiskAssessment(overallLevel, signals);
  }
}
