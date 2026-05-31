import { execSync } from "node:child_process";
import fs from "node:fs";
import type { LoomerConfig } from "./config.js";

export interface Workspace {
  name: string;
  path: string;
  branch: string;
}

export class WorkspaceManager {
  private readonly repoPath: string;

  constructor(_config: LoomerConfig, root?: string) {
    this.repoPath = root ?? process.cwd();
  }

  create(name: string, baseBranch?: string): Workspace {
    const branch = name;
    const base = baseBranch ?? this.detectBaseBranch();
    const worktreePath = `${this.repoPath}-${name}`;

    // worktree 已存在时直接返回
    if (this.worktreeExists(name)) {
      return { name, path: worktreePath, branch };
    }

    // 目录残留但非 worktree 时清理
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      execSync("git worktree prune", {
        cwd: this.repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    // 分支已存在时不带 -b，否则创建新分支
    const branchExists = this.exists(branch);
    const cmd = branchExists
      ? `git worktree add "${worktreePath}" "${branch}"`
      : `git worktree add -b "${branch}" "${worktreePath}" "${base}"`;
    execSync(cmd, {
      cwd: this.repoPath,
      encoding: "utf-8",
    });

    return { name, path: worktreePath, branch };
  }

  remove(name: string): void {
    const worktreePath = `${this.repoPath}-${name}`;
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: this.repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // worktree 不存在时不报错
    }
    try {
      execSync(`git branch -D "${name}"`, {
        cwd: this.repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // 分支不存在时不报错
    }
  }

  listAll(): Workspace[] {
    const output = execSync("git worktree list --porcelain", {
      cwd: this.repoPath,
      encoding: "utf-8",
    }).trim();
    const entries: Workspace[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        currentBranch = line.slice("branch refs/heads/".length);
        if (currentPath && currentBranch) {
          entries.push({
            name: currentBranch,
            path: currentPath,
            branch: currentBranch,
          });
        }
      }
    }
    return entries;
  }

  exists(name: string): boolean {
    try {
      const output = execSync(`git branch --list "${name}"`, {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** 检查 worktree（非分支）是否已注册 */
  worktreeExists(name: string): boolean {
    return this.listAll().some((w) => w.name === name);
  }

  private detectBaseBranch(): string {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: this.repoPath,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "master";
    }
  }
}
