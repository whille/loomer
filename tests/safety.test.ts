import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execSync } from "node:child_process"
import {
  SafetyChecks,
  RiskLevel,
  RiskSignal,
  RiskAssessment,
} from "../src/safety.js"
import { InvalidNameError } from "../src/errors.js"
import type { AutoMergeRules } from "../src/config.js"

const DEFAULT_RULES: AutoMergeRules = {
  maxFiles: 5,
  maxLines: 200,
  conflict: "review",
  testFail: "auto",
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-safety-"))
}

function createTestRepo(): string {
  const tmpDir = mkTmpDir()
  execSync("git init", { cwd: tmpDir, encoding: "utf-8" })
  execSync("git config user.email 'test@test.com'", {
    cwd: tmpDir,
    encoding: "utf-8",
  })
  execSync("git config user.name 'Test'", { cwd: tmpDir, encoding: "utf-8" })
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# test")
  execSync("git add -A", { cwd: tmpDir })
  execSync("git commit -m 'initial'", { cwd: tmpDir, encoding: "utf-8" })
  // 多加几个 commit 确保 isNewProject=false（commit count > 3）
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(tmpDir, `setup${i}.txt`), `setup ${i}`)
    execSync("git add -A", { cwd: tmpDir })
    execSync(`git commit -m 'setup ${i}'`, { cwd: tmpDir, encoding: "utf-8" })
  }
  return tmpDir
}

describe("RiskLevel", () => {
  it("有 LOW 和 HIGH 两个值", () => {
    expect(RiskLevel.LOW).toBe("LOW")
    expect(RiskLevel.HIGH).toBe("HIGH")
  })
})

describe("RiskSignal", () => {
  it("构造并序列化", () => {
    const s = new RiskSignal("test", RiskLevel.HIGH, "detail")
    expect(s.name).toBe("test")
    expect(s.level).toBe(RiskLevel.HIGH)
    expect(s.detail).toBe("detail")
    expect(s.toDict()).toEqual({
      name: "test",
      level: "HIGH",
      detail: "detail",
    })
  })
})

describe("RiskAssessment", () => {
  it("构造并序列化", () => {
    const signals = [new RiskSignal("a", RiskLevel.LOW, "ok")]
    const a = new RiskAssessment(RiskLevel.LOW, signals)
    expect(a.level).toBe(RiskLevel.LOW)
    expect(a.signals).toHaveLength(1)
    expect(a.toDict()).toEqual({
      level: "LOW",
      signals: [{ name: "a", level: "LOW", detail: "ok" }],
    })
  })
})

describe("SafetyChecks", () => {
  describe("validateName", () => {
    it("合法名称: 字母数字连字符下划线", () => {
      expect(() => SafetyChecks.validateName("LMR-004")).not.toThrow()
      expect(() => SafetyChecks.validateName("feat_branch")).not.toThrow()
      expect(() => SafetyChecks.validateName("12345")).not.toThrow()
    })

    it("合法名称: 恰好 64 字符", () => {
      expect(() => SafetyChecks.validateName("a".repeat(64))).not.toThrow()
    })

    it("非法名称: 空字符串", () => {
      expect(() => SafetyChecks.validateName("")).toThrow(InvalidNameError)
    })

    it("非法名称: 含空格", () => {
      expect(() => SafetyChecks.validateName("bad name")).toThrow(
        InvalidNameError,
      )
    })

    it("非法名称: 含特殊字符", () => {
      expect(() => SafetyChecks.validateName("bad@name!")).toThrow(
        InvalidNameError,
      )
    })

    it("非法名称: 超过 64 字符", () => {
      expect(() => SafetyChecks.validateName("a".repeat(65))).toThrow(
        InvalidNameError,
      )
    })

    it("非法名称: 含斜杠", () => {
      expect(() => SafetyChecks.validateName("bad/name")).toThrow(
        InvalidNameError,
      )
    })

    it("非法名称: 含点", () => {
      expect(() => SafetyChecks.validateName("bad.name")).toThrow(
        InvalidNameError,
      )
    })
  })

  describe("checkGitClean", () => {
    let repo: string

    beforeEach(() => {
      repo = createTestRepo()
    })

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true })
    })

    it("干净仓库返回 true", () => {
      const safety = new SafetyChecks(repo)
      expect(safety.checkGitClean()).toBe(true)
    })

    it("有未跟踪文件返回 false", () => {
      fs.writeFileSync(path.join(repo, "new-file.txt"), "content")
      const safety = new SafetyChecks(repo)
      expect(safety.checkGitClean()).toBe(false)
    })

    it("有修改的跟踪文件返回 false", () => {
      fs.writeFileSync(path.join(repo, "README.md"), "modified")
      const safety = new SafetyChecks(repo)
      expect(safety.checkGitClean()).toBe(false)
    })

    it("有暂存文件返回 false", () => {
      fs.writeFileSync(path.join(repo, "new-file.txt"), "content")
      execSync("git add new-file.txt", { cwd: repo })
      const safety = new SafetyChecks(repo)
      expect(safety.checkGitClean()).toBe(false)
    })
  })

  describe("checkGitignore", () => {
    let repo: string

    beforeEach(() => {
      repo = createTestRepo()
      fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n")
      execSync("git add -f .gitignore", { cwd: repo })
      execSync("git commit -m 'add gitignore'", {
        cwd: repo,
        encoding: "utf-8",
      })
    })

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true })
    })

    it("被忽略的目录返回 true", () => {
      const safety = new SafetyChecks(repo)
      expect(safety.checkGitignore("node_modules")).toBe(true)
    })

    it("未被忽略的目录返回 false", () => {
      const safety = new SafetyChecks(repo)
      expect(safety.checkGitignore("src")).toBe(false)
    })

    it("不存在的路径返回 false", () => {
      const safety = new SafetyChecks(repo)
      expect(safety.checkGitignore("/nonexistent/path")).toBe(false)
    })
  })

  describe("checkBranchExists", () => {
    let repo: string

    beforeEach(() => {
      repo = createTestRepo()
    })

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true })
    })

    it("存在的分支返回 true", () => {
      execSync("git checkout -b feat/test", { cwd: repo })
      execSync("git checkout master", { cwd: repo })
      const safety = new SafetyChecks(repo)
      expect(safety.checkBranchExists("feat/test")).toBe(true)
    })

    it("不存在的分支返回 false", () => {
      const safety = new SafetyChecks(repo)
      expect(safety.checkBranchExists("nonexistent")).toBe(false)
    })

    it("当前分支返回 true", () => {
      const safety = new SafetyChecks(repo)
      expect(safety.checkBranchExists("master")).toBe(true)
    })
  })

  describe("assessRisk", () => {
    let repo: string

    beforeEach(() => {
      repo = createTestRepo()
    })

    afterEach(() => {
      // 清理可能的半合并状态
      try {
        execSync("git merge --abort", {
          cwd: repo,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
      } catch {
        // 忽略
      }
      fs.rmSync(repo, { recursive: true, force: true })
    })

    function createFeatureBranch(
      repoPath: string,
      branchName: string,
    ): string {
      execSync(`git checkout -b ${branchName}`, { cwd: repoPath })
      return repoPath
    }

    describe("merge_strategy 短路", () => {
      it("always 策略直接返回 HIGH", () => {
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "always",
          DEFAULT_RULES,
          "master",
        )
        expect(result.level).toBe(RiskLevel.HIGH)
        expect(result.signals).toHaveLength(1)
        expect(result.signals[0].name).toBe("merge_strategy")
      })

      it("never 策略直接返回 LOW", () => {
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "never",
          DEFAULT_RULES,
          "master",
        )
        expect(result.level).toBe(RiskLevel.LOW)
        expect(result.signals).toHaveLength(1)
        expect(result.signals[0].name).toBe("merge_strategy")
      })
    })

    describe("信号: file_count", () => {
      it("文件数 ≤ maxFiles 为 LOW", () => {
        const branch = "feat/file-count-low"
        createFeatureBranch(repo, branch)
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(path.join(repo, `file${i}.ts`), `export const a${i} = ${i}`)
        }
        execSync("git add -A && git commit -m 'add 3 files'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "file_count")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("文件数 > maxFiles 为 HIGH", () => {
        const branch = "feat/file-count-high"
        createFeatureBranch(repo, branch)
        for (let i = 0; i < 6; i++) {
          fs.writeFileSync(path.join(repo, `file${i}.ts`), `export const a${i} = ${i}`)
        }
        execSync("git add -A && git commit -m 'add 6 files'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "file_count")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })
    })

    describe("信号: line_count", () => {
      it("行数 ≤ maxLines 为 LOW", () => {
        createFeatureBranch(repo, "feat/line-low")
        fs.writeFileSync(
          path.join(repo, "small.ts"),
          Array(10).fill("export const x = 1;").join("\n"),
        )
        execSync("git add -A && git commit -m 'small change'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "line_count")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("行数 > maxLines 为 HIGH", () => {
        createFeatureBranch(repo, "feat/line-high")
        fs.writeFileSync(
          path.join(repo, "big.ts"),
          Array(250).fill("export const x = 1;").join("\n"),
        )
        execSync("git add -A && git commit -m 'big change'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "line_count")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })
    })

    describe("信号: new_files", () => {
      it("无新文件为 LOW", () => {
        createFeatureBranch(repo, "feat/no-new")
        fs.writeFileSync(path.join(repo, "README.md"), "# modified")
        execSync("git add -A && git commit -m 'modify existing'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "new_files")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("有新文件为 HIGH", () => {
        createFeatureBranch(repo, "feat/has-new")
        fs.writeFileSync(path.join(repo, "brand-new.ts"), "export const x = 1")
        execSync("git add -A && git commit -m 'add new file'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "new_files")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })
    })

    describe("信号: public_modules", () => {
      it("修改 src/ 下文件为 HIGH", () => {
        createFeatureBranch(repo, "feat/pub-mod")
        fs.mkdirSync(path.join(repo, "src"), { recursive: true })
        fs.writeFileSync(path.join(repo, "src", "utils.ts"), "export const x = 1")
        execSync("git add -A && git commit -m 'modify src'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "public_modules")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })

      it("修改 lib/ 下文件为 HIGH", () => {
        createFeatureBranch(repo, "feat/lib-mod")
        fs.mkdirSync(path.join(repo, "lib"), { recursive: true })
        fs.writeFileSync(path.join(repo, "lib", "helper.ts"), "export const y = 1")
        execSync("git add -A && git commit -m 'modify lib'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "public_modules")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })

      it("修改非公共模块路径为 LOW", () => {
        createFeatureBranch(repo, "feat/internal-mod")
        fs.mkdirSync(path.join(repo, "internal"), { recursive: true })
        fs.writeFileSync(
          path.join(repo, "internal", "notes.txt"),
          "notes",
        )
        execSync("git add -A && git commit -m 'modify internal'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "public_modules")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("vendor/core/ 不匹配（精确路径段）", () => {
        createFeatureBranch(repo, "feat/vendor-core")
        fs.mkdirSync(path.join(repo, "vendor", "core"), { recursive: true })
        fs.writeFileSync(
          path.join(repo, "vendor", "core", "thing.ts"),
          "export const z = 1",
        )
        execSync("git add -A && git commit -m 'modify vendor/core'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "public_modules")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })
    })

    describe("信号: conflict", () => {
      it("无冲突为 LOW", () => {
        createFeatureBranch(repo, "feat/no-conflict")
        fs.writeFileSync(path.join(repo, "new.ts"), "export const a = 1")
        execSync("git add -A && git commit -m 'add file'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "conflict")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("有冲突为 HIGH", () => {
        // 在 feature 分支修改 README
        createFeatureBranch(repo, "feat/has-conflict")
        fs.writeFileSync(path.join(repo, "README.md"), "feature content")
        execSync("git add -A && git commit -m 'feature change'", {
          cwd: repo,
          encoding: "utf-8",
        })

        // 切回 master 修改同一文件
        execSync("git checkout master", { cwd: repo })
        fs.writeFileSync(path.join(repo, "README.md"), "master content")
        execSync("git add -A && git commit -m 'master change'", {
          cwd: repo,
          encoding: "utf-8",
        })

        // 切回 feature 分支
        execSync("git checkout feat/has-conflict", { cwd: repo })

        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "conflict")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })
    })

    describe("信号: test", () => {
      it("修改 *.test.ts 为 LOW", () => {
        createFeatureBranch(repo, "feat/has-test")
        fs.writeFileSync(
          path.join(repo, "utils.test.ts"),
          "test('x', () => {})",
        )
        fs.writeFileSync(
          path.join(repo, "utils.ts"),
          "export const x = 1",
        )
        execSync("git add -A && git commit -m 'add code and test'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "test")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("修改 *.spec.ts 为 LOW", () => {
        createFeatureBranch(repo, "feat/has-spec")
        fs.writeFileSync(
          path.join(repo, "utils.spec.ts"),
          "it('x', () => {})",
        )
        fs.writeFileSync(
          path.join(repo, "utils.ts"),
          "export const x = 1",
        )
        execSync("git add -A && git commit -m 'add code and spec'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "test")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("修改 tests/ 目录下文件为 LOW", () => {
        createFeatureBranch(repo, "feat/has-test-dir")
        fs.mkdirSync(path.join(repo, "tests"), { recursive: true })
        fs.writeFileSync(
          path.join(repo, "tests", "main.ts"),
          "test('x', () => {})",
        )
        fs.writeFileSync(
          path.join(repo, "main.ts"),
          "export const x = 1",
        )
        execSync("git add -A && git commit -m 'add code and test dir'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "test")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("修改 __tests__/ 目录下文件为 LOW", () => {
        createFeatureBranch(repo, "feat/has-jest-dir")
        fs.mkdirSync(path.join(repo, "__tests__"), { recursive: true })
        fs.writeFileSync(
          path.join(repo, "__tests__", "main.ts"),
          "test('x', () => {})",
        )
        fs.writeFileSync(
          path.join(repo, "main.ts"),
          "export const x = 1",
        )
        execSync("git add -A && git commit -m 'add code and __tests__'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "test")!
        expect(sig.level).toBe(RiskLevel.LOW)
      })

      it("有改动但无测试文件为 HIGH", () => {
        createFeatureBranch(repo, "feat/no-test")
        fs.writeFileSync(path.join(repo, "utils.ts"), "export const x = 1")
        execSync("git add -A && git commit -m 'add code only'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        const sig = result.signals.find((s) => s.name === "test")!
        expect(sig.level).toBe(RiskLevel.HIGH)
      })
    })

    describe("整体级别", () => {
      it("全部 LOW 时整体为 LOW", () => {
        // 先在 master 添加一个 .test.ts 文件，这样 feature 分支修改它不算 new_files
        execSync("git checkout master", { cwd: repo })
        fs.writeFileSync(path.join(repo, "app.test.ts"), "test('x', () => {})")
        execSync("git add -A && git commit -m 'add initial test'", {
          cwd: repo,
          encoding: "utf-8",
        })
        createFeatureBranch(repo, "feat/all-low")
        // 修改已有文件（不触发 new_files），修改 .test.ts（不触发 test HIGH）
        fs.writeFileSync(path.join(repo, "app.test.ts"), "test('y', () => {})")
        fs.writeFileSync(path.join(repo, "README.md"), "# modified")
        execSync("git add -A && git commit -m 'modify test and readme'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        expect(result.level).toBe(RiskLevel.LOW)
      })

      it("任一 HIGH 时整体为 HIGH", () => {
        createFeatureBranch(repo, "feat/one-high")
        // file_count 会在 new_files HIGH 的同时触发（新文件也算 file_count）
        // 只需确保超过 maxFiles
        for (let i = 0; i < 6; i++) {
          fs.writeFileSync(
            path.join(repo, `file${i}.test.ts`),
            `test('${i}', () => {});`,
          )
        }
        execSync("git add -A && git commit -m 'many test files'", {
          cwd: repo,
          encoding: "utf-8",
        })
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        // file_count 超过 5 → HIGH → 整体 HIGH
        expect(result.level).toBe(RiskLevel.HIGH)
      })
    })

    describe("空 diff（无改动）", () => {
      it("feature 分支无改动时所有信号 LOW", () => {
        createFeatureBranch(repo, "feat/no-changes")
        // 无任何新 commit
        const safety = new SafetyChecks(repo)
        const result = safety.assessRisk(
          "test",
          repo,
          "auto",
          DEFAULT_RULES,
          "master",
        )
        expect(result.level).toBe(RiskLevel.LOW)
        const fileCount = result.signals.find((s) => s.name === "file_count")!
        expect(fileCount.level).toBe(RiskLevel.LOW)
        const test = result.signals.find((s) => s.name === "test")!
        expect(test.level).toBe(RiskLevel.LOW)
      })
    })
  })
})
