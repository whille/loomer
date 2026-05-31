import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// 支持 HOME 环境变量覆盖（便于测试）
function getHome(): string {
  return process.env.HOME || os.homedir()
}

export interface AutoMergeRules {
  maxFiles: number
  maxLines: number
  conflict: "review" | "auto"
  testFail: "review" | "auto"
}

export interface LoomerConfigData {
  baseBranch: string
  claudePath: string
  claudeArgs: string[]
  defaultPort: number
  defaultTimeoutMinutes: number
  maxConcurrent: number
  stateDir: string
  skillPrefix: boolean
  mergeStrategy: "auto" | "always" | "never"
  createPr: boolean
  autoMergeRules: AutoMergeRules
}

const DEFAULTS: LoomerConfigData = {
  baseBranch: "",
  claudePath: "claude",
  claudeArgs: [],
  defaultPort: 3000,
  defaultTimeoutMinutes: 30,
  maxConcurrent: 5,
  stateDir: "~/.loomer",
  skillPrefix: true,
  mergeStrategy: "auto",
  createPr: false,
  autoMergeRules: {
    maxFiles: 5,
    maxLines: 200,
    conflict: "review",
    testFail: "auto",
  },
}

// config.json 中允许的 key 集合
const KNOWN_KEYS = new Set(Object.keys(DEFAULTS))

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

function applyOverrides(
  base: LoomerConfigData,
  overrides: Record<string, unknown>,
): LoomerConfigData {
  const result = { ...base }
  const knownTopLevelKeys = KNOWN_KEYS

  for (const [key, value] of Object.entries(overrides)) {
    if (!knownTopLevelKeys.has(key)) continue
    if (key === "autoMergeRules" && typeof value === "object" && value !== null) {
      result.autoMergeRules = { ...result.autoMergeRules, ...(value as Partial<AutoMergeRules>) }
    } else {
      (result as Record<string, unknown>)[key] = value
    }
  }
  return result
}

export class LoomerConfig implements LoomerConfigData {
  baseBranch: string
  claudePath: string
  claudeArgs: string[]
  defaultPort: number
  defaultTimeoutMinutes: number
  maxConcurrent: number
  stateDir: string
  skillPrefix: boolean
  mergeStrategy: "auto" | "always" | "never"
  createPr: boolean
  autoMergeRules: AutoMergeRules

  /** ~ 展开后的绝对路径 */
  resolvedStateDir: string

  constructor(data: LoomerConfigData = DEFAULTS) {
    this.baseBranch = data.baseBranch
    this.claudePath = data.claudePath
    this.claudeArgs = data.claudeArgs
    this.defaultPort = data.defaultPort
    this.defaultTimeoutMinutes = data.defaultTimeoutMinutes
    this.maxConcurrent = data.maxConcurrent
    this.stateDir = data.stateDir
    this.skillPrefix = data.skillPrefix
    this.mergeStrategy = data.mergeStrategy
    this.createPr = data.createPr
    this.autoMergeRules = { ...data.autoMergeRules }
    this.resolvedStateDir = this.stateDir.replace(
      /^~(?=\/)/,
      getHome(),
    )
  }

  /**
   * 三层覆盖加载：全局 ~/.loomer/config.json → 项目 .loomer.json → CLI overrides
   * 优先级：CLI > 项目 > 全局 > 内置默认
   * 未知 key 静默忽略
   */
  static load(configPath?: string, overrides?: Partial<LoomerConfigData>): LoomerConfig {
    let data = { ...DEFAULTS }

    // 1. 加载全局 ~/.loomer/config.json
    const globalPath = path.join(getHome(), ".loomer", "config.json")
    const globalData = readJsonFile(globalPath)
    if (globalData) {
      data = applyOverrides(data, globalData)
    }

    // 2. 加载项目 .loomer.json（覆盖全局）
    if (configPath) {
      const projectData = readJsonFile(configPath)
      if (projectData) {
        data = applyOverrides(data, projectData)
      }
    }

    // 3. 应用 CLI overrides
    if (overrides) {
      data = applyOverrides(data, overrides as Record<string, unknown>)
    }

    return new LoomerConfig(data)
  }
}
