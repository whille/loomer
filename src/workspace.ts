import { execFileSync } from "node:child_process";
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
    const branch =
      baseBranch || this.detectBaseBranch() || "master";
    const worktreePath = `${this.repoPath}-${name}`;

    // 清理残留 worktree
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    } catch {
      // 忽略
    }

    const branchExists = this.exists(name);
    if (branchExists) {
      execFileSync("git", ["worktree", "add", worktreePath, branch], {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    } else {
      execFileSync("git", ["worktree", "add", "-b", name, worktreePath, branch], {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    }

    return { name, path: worktreePath, branch: name };
  }

  remove(name: string): void {
    const worktreePath = `${this.repoPath}-${name}`;
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    } catch {
      // worktree 可能已不存在
    }
    try {
      execFileSync("git", ["branch", "-D", name], {
        cwd: this.repoPath,
        encoding: "utf-8",
      });
    } catch {
      // 分支可能已不存在
    }
  }

  listAll(): Workspace[] {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    const worktrees: Workspace[] = [];
    const lines = output.trim().split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("worktree ")) {
        const wtPath = lines[i].split(" ").slice(1).join(" ");
        const branchLine = lines
          .slice(i + 1)
          .find((l) => l.startsWith("branch "));
        if (branchLine) {
          const branch = branchLine.split(" ")[1].replace(/^refs\/heads\//, "");
          worktrees.push({
            name: branch,
            path: wtPath,
            branch,
          });
        }
      }
    }
    return worktrees;
  }

  exists(name: string): boolean {
    const output = execFileSync("git", ["branch", "--list", name], {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return output.trim().length > 0;
  }

  private detectBaseBranch(): string {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.repoPath,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "master";
    }
  }
}
