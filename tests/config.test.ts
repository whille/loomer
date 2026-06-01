import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { LoomerConfig } from "../src/config.js"

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loomer-test-"))
}

describe("LoomerConfig", () => {
  let tmpDir: string
  let origHome: string

  beforeEach(() => {
    tmpDir = mkTmpDir()
    origHome = process.env.HOME ?? ""
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    process.env.HOME = origHome
  })

  it("返回内置默认值", () => {
    const cfg = LoomerConfig.load()
    expect(cfg.baseBranch).toBe("")
    expect(cfg.claudePath).toBe("claude")
    expect(cfg.claudeArgs).toEqual([])
    expect(cfg.defaultPort).toBe(3000)
    expect(cfg.defaultTimeoutMinutes).toBe(30)
    expect(cfg.maxConcurrent).toBe(3)
    expect(cfg.stateDir).toBe("~/.loomer")
    expect(cfg.mergeStrategy).toBe("auto")
    expect(cfg.createPr).toBe(false)
    expect(cfg.autoMergeRules.maxFiles).toBe(20)
    expect(cfg.autoMergeRules.maxLines).toBe(1000)
    expect(cfg.autoMergeRules.conflict).toBe("review")
    expect(cfg.autoMergeRules.testFail).toBe("auto")
  })

  it("加载全局 ~/.loomer/config.json", () => {
    const loomerDir = path.join(tmpDir, ".loomer")
    fs.mkdirSync(loomerDir, { recursive: true })
    fs.writeFileSync(
      path.join(loomerDir, "config.json"),
      JSON.stringify({ defaultPort: 4000, maxConcurrent: 10 }),
    )
    process.env.HOME = tmpDir

    const cfg = LoomerConfig.load()
    expect(cfg.defaultPort).toBe(4000)
    expect(cfg.maxConcurrent).toBe(10)
    // 其他字段保持默认
    expect(cfg.defaultTimeoutMinutes).toBe(30)
  })

  it("加载项目 .loomer.json 覆盖全局", () => {
    // 全局配置
    const loomerDir = path.join(tmpDir, ".loomer")
    fs.mkdirSync(loomerDir, { recursive: true })
    fs.writeFileSync(
      path.join(loomerDir, "config.json"),
      JSON.stringify({ defaultPort: 4000, maxConcurrent: 10 }),
    )
    process.env.HOME = tmpDir

    // 项目配置
    const projectCfg = path.join(tmpDir, ".loomer.json")
    fs.writeFileSync(projectCfg, JSON.stringify({ maxConcurrent: 3 }))

    const cfg = LoomerConfig.load(projectCfg)
    expect(cfg.defaultPort).toBe(4000) // 来自全局
    expect(cfg.maxConcurrent).toBe(3) // 项目覆盖全局
  })

  it("CLI overrides 覆盖项目配置", () => {
    const projectCfg = path.join(tmpDir, ".loomer.json")
    fs.writeFileSync(projectCfg, JSON.stringify({ maxConcurrent: 3 }))

    const cfg = LoomerConfig.load(projectCfg, { maxConcurrent: 1, createPr: true })
    expect(cfg.maxConcurrent).toBe(1) // CLI 覆盖项目
    expect(cfg.createPr).toBe(true) // CLI 新增
    expect(cfg.defaultPort).toBe(3000) // 默认值不变
  })

  it("覆盖优先级：CLI > 项目 > 全局 > 内置默认", () => {
    const loomerDir = path.join(tmpDir, ".loomer")
    fs.mkdirSync(loomerDir, { recursive: true })
    fs.writeFileSync(
      path.join(loomerDir, "config.json"),
      JSON.stringify({ defaultTimeoutMinutes: 60, maxConcurrent: 8 }),
    )
    process.env.HOME = tmpDir

    const projectCfg = path.join(tmpDir, ".loomer.json")
    fs.writeFileSync(projectCfg, JSON.stringify({ maxConcurrent: 2 }))

    const cfg = LoomerConfig.load(projectCfg, { maxConcurrent: 1 })
    // CLI > 项目 > 全局 > 默认
    expect(cfg.maxConcurrent).toBe(1) // CLI
    expect(cfg.defaultTimeoutMinutes).toBe(60) // 全局（项目未覆盖）
    expect(cfg.defaultPort).toBe(3000) // 内置默认
  })

  it("未知 key 静默忽略", () => {
    const loomerDir = path.join(tmpDir, ".loomer")
    fs.mkdirSync(loomerDir, { recursive: true })
    fs.writeFileSync(
      path.join(loomerDir, "config.json"),
      JSON.stringify({ unknownKey: "value", defaultPort: 5000 }),
    )
    process.env.HOME = tmpDir

    const cfg = LoomerConfig.load()
    expect(cfg.defaultPort).toBe(5000)
    // 不应抛出异常
  })

  it("state_dir ~ 展开为 HOME 目录", () => {
    process.env.HOME = tmpDir
    const cfg = LoomerConfig.load(undefined, { stateDir: "~/custom-loomer" })
    expect(cfg.resolvedStateDir).toBe(path.join(tmpDir, "custom-loomer"))
  })

  it("配置文件不存在时静默使用默认值", () => {
    process.env.HOME = path.join(tmpDir, "nonexistent")
    const cfg = LoomerConfig.load()
    expect(cfg.defaultPort).toBe(3000)
  })

  it("configPath 不存在时静默跳过", () => {
    const cfg = LoomerConfig.load("/nonexistent/path/.loomer.json")
    expect(cfg.defaultPort).toBe(3000)
  })
})
