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

## Lessons Learned（e2e 经验）

1. **package.json 增量修改**：每个 task 只加自己需要的字段（exports/bin/dependencies），不要覆盖已有字段。loomer 会自动并集合并。
2. **不要修改其他 task 的文件**：TS-002 只加 cli.ts，不改 greet.ts。同文件双方都改会导致 add/add 冲突。
3. **lock 文件冲突取 theirs**：package-lock.json 冲突无法手动 merge，取 theirs 后 npm install 重新生成即可。
4. **hints 字段**：每个 US 的 hints 告诉 agent 该创建什么文件、不该碰什么文件、package.json 只做增量修改。
5. **TS-003 容错**：如果依赖的 task 未完成，基于 PRD 描述编写，不要等。

## User Stories

### US-000: 项目骨架

**Acceptance Criteria:**
- 创建 package.json（name: mini-greet, type: module, scripts: build/dev/test，**不含 bin/exports/dependencies 字段**）
- 创建 tsconfig.json（target ES2022, module NodeNext, strict, outDir dist）
- 创建 src/types.ts — 导出 Language='en'|'zh'|'ja' 和 GreetingConfig={name:string,lang:Language}
- 创建 CLAUDE.md — 技术栈、目录结构、编码规范
- npm install && npm run build 通过
- git commit（消息含 TS-000）

**Hints:**
- 只创建基础骨架，不要添加 bin、exports、dependencies
- 后续 TS-001 会加 exports + vitest，TS-002 会加 bin + commander
- package.json 冲突由 loomer 自动合并，不要覆盖

### US-001: 核心问候函数

**Acceptance Criteria:**
- src/greet.ts — export function greet(name: string, lang: Language = 'en'): string
- src/greet.test.ts — vitest 覆盖 en/zh/ja 三种语言
- src/index.ts — re-export greet 和 Language
- package.json **增量**增加 exports 字段和 vitest devDependency
- npm install && npm test 通过
- git commit（消息含 TS-001）

**Hints:**
- 不要修改 src/types.ts（TS-000 已创建）
- package.json 只做增量修改：加 exports + vitest，不要删除已有字段
- 不要添加 bin 或 dependencies（TS-002 负责）

### US-002: CLI 入口

**Acceptance Criteria:**
- src/cli.ts — 使用 commander，greet <name> --lang <lang>，默认 en
- package.json **增量**增加 bin 字段和 commander dependency
- npm install && npm run build 通过
- git commit（消息含 TS-002）

**Hints:**
- import { greet } from './greet.js'（TS-001 已创建）
- package.json 只做增量修改：加 bin + commander，不要删除已有字段
- 不要修改 src/greet.ts 或 src/greet.test.ts

### US-003: README

**Acceptance Criteria:**
- README.md — Quick Start、CLI 示例、语言列表
- git commit（消息含 TS-003）

**Hints:**
- 参考已有 src/cli.ts 和 src/greet.ts 写示例
- 如果 TS-001 或 TS-002 代码不可用，基于 PRD 中的目标描述编写

## Task DAG

| Task | User Story | Depends | Parallel | Branch |
|------|-----------|---------|----------|--------|
| TS-000 | US-000 | - | no | feat/scaffold |
| TS-001 | US-001 | TS-000 | **yes** | feat/greet-core |
| TS-002 | US-002 | TS-000 | **yes** | feat/cli-entry |
| TS-003 | US-003 | TS-001, TS-002 | no | feat/readme |

## Coverage Map

| 场景 | Task |
|------|------|
| 串行启动 | TS-000 |
| 并行开发 | TS-001 + TS-002 |
| DONE 检测 | exit_code=0 + auto-commit |
| LOW 风险自动合并 | TS-000, TS-003（小改动） |
| 合并冲突 → 自动解决 | TS-001+TS-002 都改 package.json（增量合并） |
| lock 文件冲突 → 取 theirs | package-lock.json |
| .ts 同文件冲突 → ours 优先 | greet.ts add/add 冲突 |
| 验证门控 | tsc --noEmit |
| ACCEPTED + worktree 清理 | LOW 风险路径 |
| 计划完成 | 全部 ACCEPTED 后检测 |

## Non-Goals

- 不做数据库
- 不做 Web UI
- 不做多包 monorepo
- 不做 i18n 框架（硬编码三语言即可）
