import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { WorkspaceManager } from "../src/workspace.js";
import { InvalidNameError } from "../src/errors.js";
import type { LoomerConfig } from "../src/config.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-workspace-"));
}

function createTestRepo(): string {
  const tmpDir = mkTmpDir();
  execSync("git init", { cwd: tmpDir, encoding: "utf-8" });
  execSync("git config user.email 'test@test.com'", {
    cwd: tmpDir,
    encoding: "utf-8",
  });
  execSync("git config user.name 'Test'", { cwd: tmpDir, encoding: "utf-8" });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# test");
  execSync("git add -A", { cwd: tmpDir });
  execSync("git commit -m 'initial'", { cwd: tmpDir, encoding: "utf-8" });
  return tmpDir;
}

function makeConfig(repoPath: string): LoomerConfig {
  return {
    baseBranch: "",
    claudePath: "claude",
    claudeArgs: [],
    defaultPort: 3000,
    defaultTimeoutMinutes: 30,
    maxConcurrent: 5,
    stateDir: path.join(repoPath, ".loomer"),
    skillPrefix: true,
    mergeStrategy: "auto" as const,
    createPr: false,
    autoMergeRules: {
      maxFiles: 5,
      maxLines: 200,
      conflict: "review" as const,
      testFail: "auto" as const,
    },
    resolvedStateDir: path.join(repoPath, ".loomer"),
  };
}

function cleanupWorktree(repoPath: string, name: string): void {
  try {
    const wtPath = path.join(repoPath, ".worktrees", name);
    execSync(`git worktree remove --force "${wtPath}"`, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // 忽略
  }
  try {
    execSync(`git branch -D "${name}"`, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // 忽略
  }
}

describe("WorkspaceManager", () => {
  let repo: string;
  let config: LoomerConfig;
  let wm: WorkspaceManager;

  beforeEach(() => {
    repo = createTestRepo();
    config = makeConfig(repo);
    wm = new WorkspaceManager(config, repo);
  });

  afterEach(() => {
    // 清理所有 worktree
    try {
      const list = execSync("git worktree list --porcelain", {
        cwd: repo,
        encoding: "utf-8",
      });
      const entries = list.split("\n\n").filter(Boolean);
      for (const entry of entries) {
        const worktreeLine = entry
          .split("\n")
          .find((l) => l.startsWith("worktree "));
        if (worktreeLine) {
          const wtPath = worktreeLine.slice("worktree ".length);
          if (wtPath !== repo) {
            try {
              execSync(`git worktree remove --force "${wtPath}"`, {
                cwd: repo,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              });
            } catch {
              // 忽略
            }
          }
        }
      }
      // 清理残留分支
      try {
        const branches = execSync("git branch --list", {
          cwd: repo,
          encoding: "utf-8",
        });
        for (const line of branches.split("\n")) {
          const name = line.trim().replace(/^\*?\s*/, "");
          if (name && name !== "master" && name !== "main") {
            try {
              execSync(`git branch -D "${name}"`, {
                cwd: repo,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              });
            } catch {
              // 忽略
            }
          }
        }
      } catch {
        // 忽略
      }
    } catch {
      // 忽略
    }
    fs.rmSync(repo, { recursive: true, force: true });
  });

  describe("create", () => {
    it("创建 worktree 并返回 Workspace 对象", () => {
      const ws = wm.create("LMR-001");
      expect(ws.name).toBe("LMR-001");
      expect(ws.branch).toBe("LMR-001");
      expect(fs.existsSync(ws.path)).toBe(true);
    });

    it("默认在 .worktrees/<name> 创建目录", () => {
      const ws = wm.create("LMR-002");
      // macOS /var vs /private/var 符号链接，normalize 后比较
      expect(fs.realpathSync(ws.path)).toBe(
        fs.realpathSync(path.join(repo, ".worktrees", "LMR-002")),
      );
    });

    it("创建的分支名与 name 一致", () => {
      const ws = wm.create("feat-abc");
      const branches = execSync("git branch --list", {
        cwd: repo,
        encoding: "utf-8",
      });
      expect(branches).toContain("feat-abc");
      expect(ws.branch).toBe("feat-abc");
    });

    it("可指定 baseBranch", () => {
      // 在 master 上先创建一个 base 分支
      execSync("git checkout -b dev-base", { cwd: repo });
      fs.writeFileSync(path.join(repo, "dev.txt"), "dev");
      execSync("git add -A && git commit -m 'dev base'", {
        cwd: repo,
        encoding: "utf-8",
      });
      execSync("git checkout master", { cwd: repo });

      const ws = wm.create("LMR-003", "dev-base");
      expect(ws.branch).toBe("LMR-003");
      // worktree 应包含 dev-base 的文件
      expect(fs.existsSync(path.join(ws.path, "dev.txt"))).toBe(true);
    });

    it("重复创建同名 worktree 抛出错误", () => {
      wm.create("LMR-004");
      expect(() => wm.create("LMR-004")).toThrow();
    });

    it("非法名称抛出 InvalidNameError", () => {
      expect(() => wm.create("bad name")).toThrow(InvalidNameError);
      expect(() => wm.create("bad@name")).toThrow(InvalidNameError);
      expect(() => wm.create("a".repeat(65))).toThrow(InvalidNameError);
    });
  });

  describe("remove", () => {
    it("移除已创建的 worktree", () => {
      const ws = wm.create("LMR-005");
      expect(fs.existsSync(ws.path)).toBe(true);
      wm.remove("LMR-005");
      expect(fs.existsSync(ws.path)).toBe(false);
    });

    it("移除后分支也被删除", () => {
      wm.create("LMR-006");
      wm.remove("LMR-006");
      const branches = execSync("git branch --list", {
        cwd: repo,
        encoding: "utf-8",
      });
      expect(branches).not.toContain("LMR-006");
    });

    it("移除不存在的 worktree 不抛错", () => {
      expect(() => wm.remove("nonexistent")).not.toThrow();
    });
  });

  describe("listAll", () => {
    it("空仓库返回空数组", () => {
      expect(wm.listAll()).toEqual([]);
    });

    it("返回所有已创建的 worktree", () => {
      wm.create("LMR-010");
      wm.create("LMR-011");
      const list = wm.listAll();
      expect(list).toHaveLength(2);
      const names = list.map((w) => w.name).sort();
      expect(names).toEqual(["LMR-010", "LMR-011"]);
    });

    it("返回的 Workspace 对象字段完整", () => {
      wm.create("LMR-012");
      const list = wm.listAll();
      const ws = list.find((w) => w.name === "LMR-012")!;
      expect(ws).toBeDefined();
      expect(ws.name).toBe("LMR-012");
      expect(ws.branch).toBe("LMR-012");
      expect(typeof ws.path).toBe("string");
      expect(ws.path.length).toBeGreaterThan(0);
    });

    it("移除后 listAll 不再包含", () => {
      wm.create("LMR-013");
      wm.create("LMR-014");
      wm.remove("LMR-013");
      const list = wm.listAll();
      expect(list.map((w) => w.name)).toEqual(["LMR-014"]);
    });
  });

  describe("exists", () => {
    it("存在的 worktree 返回 true", () => {
      wm.create("LMR-020");
      expect(wm.exists("LMR-020")).toBe(true);
    });

    it("不存在的 worktree 返回 false", () => {
      expect(wm.exists("nonexistent")).toBe(false);
    });

    it("移除后返回 false", () => {
      wm.create("LMR-021");
      wm.remove("LMR-021");
      expect(wm.exists("LMR-021")).toBe(false);
    });
  });
});
