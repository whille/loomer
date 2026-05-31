import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LoomerConfig } from "./config.js";
import { SafetyChecks } from "./safety.js";

export interface Workspace {
  name: string;
  path: string;
  branch: string;
}

export class WorkspaceManager {
  private readonly config: LoomerConfig;
  private readonly root: string;

  constructor(config: LoomerConfig, root?: string) {
    this.config = config;
    this.root = fs.realpathSync(root ?? process.cwd());
  }

  create(name: string, baseBranch?: string): Workspace {
    SafetyChecks.validateName(name);
    const base = baseBranch ?? this._detectBaseBranch();
    const wtPath = path.join(this.root, ".worktrees", name);

    execFileSync("git", ["worktree", "add", "-b", name, wtPath, base], {
      cwd: this.root,
      encoding: "utf-8",
    });

    return { name, path: wtPath, branch: name };
  }

  remove(name: string): void {
    const wtPath = path.join(this.root, ".worktrees", name);
    if (!fs.existsSync(wtPath)) return;

    try {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: this.root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      // remove --force 失败且目录仍存在 → 真正的错误
      if (fs.existsSync(wtPath)) {
        throw new Error(
          `Failed to remove worktree at ${wtPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    try {
      execFileSync("git", ["branch", "-D", name], {
        cwd: this.root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // 分支可能已被上游删除，不再存在则无碍
    }
  }

  listAll(): Workspace[] {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: this.root,
      encoding: "utf-8",
    });

    const entries = output.trim().split("\n\n").filter(Boolean);
    const result: Workspace[] = [];

    for (const entry of entries) {
      const lines = entry.split("\n");
      const wtPath = lines
        .find((l) => l.startsWith("worktree "))
        ?.slice("worktree ".length);
      const branch = lines
        .find((l) => l.startsWith("branch "))
        ?.slice("branch ".length);
      if (!wtPath || wtPath === this.root) continue;
      const name = path.basename(wtPath);
      if (branch) {
        result.push({ name, path: wtPath, branch: path.basename(branch) });
      }
    }

    return result;
  }

  exists(name: string): boolean {
    return this.listAll().some((w) => w.name === name);
  }

  private _detectBaseBranch(): string {
    if (this.config.baseBranch) return this.config.baseBranch;
    for (const candidate of ["main", "master"]) {
      try {
        execFileSync("git", ["rev-parse", "--verify", candidate], {
          cwd: this.root,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return candidate;
      } catch {
        continue;
      }
    }
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: this.root,
      encoding: "utf-8",
    }).trim();
    if (head === "HEAD") {
      throw new Error(
        "Cannot detect base branch: repository has no commits. Specify baseBranch explicitly.",
      );
    }
    return head;
  }
}
