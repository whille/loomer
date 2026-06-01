# PRD: mini-greet — 多语言问候 CLI

> Loomer e2e 集成测试项目 #1。设计目标：agent 全流程 ~5 分钟完成，覆盖 DAG 并行、LOW 自动合并、package.json 冲突自动解决、依赖解锁。

## Introduction

极简多语言问候命令行工具。输入名字 → 输出问候语。3 个源文件 + 1 个测试文件 + README。无数据库、无框架、无外部依赖。

## Goals

- `npx tsx src/cli.ts greet Alice` → `Hello, Alice!`
- `npx tsx src/cli.ts greet Alice --lang zh` → `你好, Alice!`
- 支持 en/zh/ja 三种语言
- 核心纯函数可单元测试
- 整个项目 agent 5 分钟内完成

## User Stories

### US-000: 项目骨架

**Acceptance Criteria:**
- 创建 package.json（name: mini-greet, type: module, scripts: build/dev/test，**不**含 bin 字段）
- 创建 tsconfig.json（target ES2022, module NodeNext, strict, outDir dist）
- 创建 src/types.ts：导出 `Language` 类型（"en"|"zh"|"ja"）和 `GreetingConfig` 接口（`{ name: string; lang: Language }`）
- 创建 CLAUDE.md：技术栈、目录结构、编码规范
- `npm run build` 通过（仅有空类型文件也可）

### US-001: 核心问候模块

**Acceptance Criteria:**
- 创建 src/greet.ts：导出 `greet(config: GreetingConfig): string`
  - en → "Hello, {name}!"
  - zh → "你好, {name}!"
  - ja → "こんにちは, {name}!"
- 创建 src/greet.test.ts：覆盖三语言 + 默认语言（en）
- 创建 src/index.ts：导出 { greet, Language }，作为包入口
- **修改 package.json**：添加 `"exports": { ".": "./dist/index.js" }`
- `npm run build && npx vitest run` 通过

### US-002: CLI 入口

**Acceptance Criteria:**
- 创建 src/cli.ts：使用 commander，`greet <name> [--lang en|zh|ja]` 命令
- 默认语言 en，`--lang` 可选
- **修改 package.json**：添加 `"bin": { "mini-greet": "./dist/cli.js" }` 和 `"scripts"` 中添加 `"start": "node dist/cli.js"`
- `npm run build && node dist/cli.js greet World --lang ja` 输出 "こんにちは, World!"
- 类型检查通过

### US-003: README

**Acceptance Criteria:**
- 创建 README.md：项目名、一句话描述、Quick Start（install + build + 3 个使用示例）、支持的 Language 列表
- 不超过 40 行
- 类型检查通过

## 任务拆分

### TS-000: 项目骨架
- 对应: US-000
- 依赖: 无
- 可并行: 否
- 分支: feat/scaffold
- 预估: 1 分钟
- **测试覆盖点**: worktree 创建、agent 启动、DONE 检测、LOW 风险自动 ACCEPTED + worktree 清理、**修改 package.json → 与 TS-001/TS-002 并发 merge 互斥锁验证**

### TS-001: 核心问候模块
- 对应: US-001
- 依赖: TS-000
- 可并行: 是（与 TS-002 并行）
- 分支: feat/greet-module
- 预估: 2 分钟
- **测试覆盖点**: 并行 DAG 执行、新增文件（new_files 信号 LOW 因为 isAllNewFiles）、小改动 → LOW 风险自动合并、**与 TS-002 在 package.json 上冲突 → 触发冲突自动解决**

### TS-002: CLI 入口
- 对应: US-002
- 依赖: TS-000
- 可并行: 是（与 TS-001 并行）
- 分支: feat/cli-entry
- 预估: 2 分钟
- **测试覆盖点**: 并行 DAG 执行、**修改 package.json → 与 TS-001 冲突 → 触发 package.json 并集合并自动解决**、冲突解决后 tsc 验证

### TS-003: README
- 对应: US-003
- 依赖: TS-001, TS-002
- 可并行: 否
- 分支: feat/readme
- 预估: 1 分钟
- **测试覆盖点**: DAG 依赖解锁（TS-001+TS-002 完成后才启动）、文档类任务、计划完成检测

## 覆盖的 Loomer 流程环节

| 环节 | 覆盖方式 |
|------|---------|
| PRD 解析 | prd.json 格式 |
| DAG 验证 | 4 个 task，有环会报错 |
| Worktree 创建 | 4 个 worktree |
| 并行执行 | TS-001 ∥ TS-002 |
| 依赖解锁 | TS-003 等待 TS-001+TS-002 |
| DONE 检测 | exit_code=0 + auto-commit |
| LOW 风险自动合并 | TS-000, TS-003（小改动） |
| 合并冲突 → 自动解决 | TS-001+TS-002 都改 package.json |
| 验证门控 | 冲突解决后 tsc --noEmit |
| ACCEPTED + worktree 清理 | LOW 风险路径 |
| 计划完成 | 全部 ACCEPTED 后检测 |

## Non-Goals

- 不做数据库
- 不做 Web UI
- 不做多包 monorepo
- 不做 i18n 框架（硬编码三语言即可）
