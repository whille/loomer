import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { WorkspaceManager } from "../src/workspace.js";
import { LoomerConfig } from "../src/config.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-workspace-"));
}

function createTestRepo(): string {
  const tmpDir = mkTmpDir();
  execSync("git init", { cwd: tmpDir, encoding: "utf-8" });
  execSync("git config user.email 'test@test.com'", { cwd: tmpDir, encoding: "utf-8" });
  execSync("git config user.name 'Test'", { cwd: tmpDir, encoding: "utf-8" });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# test");
  execSync("git add -A", { cwd: tmpDir });
  execSync("git commit -m 'initial'", { cwd: tmpDir, encoding: "utf-8" });
  return tmpDir;
}

function makeConfig(): LoomerConfig {
  return new LoomerConfig();
}

describe("WorkspaceManager", () => {
  let repo: string;
  let config: LoomerConfig;
  let wm: WorkspaceManager;

  beforeEach(() => {
    repo = createTestRepo();
    config = makeConfig();
    wm = new WorkspaceManager(config, repo);
  });

  afterEach(() => {
    // 清理所有 worktree
    try {
      execSync("git worktree prune", { cwd: repo, encoding: "utf-8" });
    } catch {
      // 忽略
    }
    fs.rmSync(repo, { recursive: true, force: true });
  });

  describe("create", () => {
    it("创建 worktree 并返回 Workspace", () => {
      const ws = wm.create("test-agent");
      expect(ws.name).toBe("test-agent");
      expect(ws.branch).toBe("test-agent");
      expect(fs.existsSync(ws.path)).toBe(true);
    });

    it("使用指定 baseBranch", () => {
      execSync("git checkout -b develop", { cwd: repo, encoding: "utf-8" });
      execSync("git checkout master", { cwd: repo, encoding: "utf-8" });
      const ws = wm.create("test-agent", "develop");
      expect(ws.branch).toBe("test-agent");
    });
  });

  describe("remove", () => {
    it("删除 worktree", () => {
      const ws = wm.create("test-agent");
      wm.remove("test-agent");
      expect(fs.existsSync(ws.path)).toBe(false);
    });

    it("删除不存在的 worktree 不报错", () => {
      expect(() => wm.remove("nonexistent")).not.toThrow();
    });
  });

  describe("listAll", () => {
    it("返回所有 worktree", () => {
      wm.create("agent-a");
      wm.create("agent-b");
      const list = wm.listAll();
      expect(list.length).toBeGreaterThanOrEqual(2);
      const names = list.map((w) => w.name);
      expect(names).toContain("agent-a");
      expect(names).toContain("agent-b");
    });
  });

  describe("exists", () => {
    it("存在的分支返回 true", () => {
      wm.create("test-agent");
      expect(wm.exists("test-agent")).toBe(true);
    });

    it("不存在的分支返回 false", () => {
      expect(wm.exists("nonexistent")).toBe(false);
    });
  });
});
