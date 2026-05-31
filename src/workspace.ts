import { execSync } from "node:child_process";
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

    // 创建 worktree（同时创建分支）
    execSync(`git worktree add -b ${branch} "${worktreePath}" ${base}`, {
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
      execSync(`git branch -D ${name}`, {
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
