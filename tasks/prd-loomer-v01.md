# PRD: Loomer v0.1 — Node.js AI Agent 编排器

## Introduction

从 conductor-ui Python 代码库（2,657 行核心代码）转换为 Node.js 实现。Loomer 是开源 AI coding agent 编排工具，核心能力：PRD 驱动 DAG 并行调度 + 风险分级审查 + 自动 merge/PR。

本文档基于 `doc/` 下 7 份设计文档，将 12 个模块拆为 13 个 User Story，最大化 DAG 并行度。

技术栈参考 Claude Code（kscc）：TypeScript + ESM + Bun + Biome。

## Goals

- 1:1 对应 conductor-ui 全部功能，改进 Node.js 不擅长的部分（fcntl → SQLite WAL, Popen → spawn）
- 每个 US 可独立测试、独立提交
- 并行度最大化：Wave 1 可同时启动 6 个 agent
- 测试覆盖率核心模块 > 80%
- Dogfooding 教训全部内化（详见 doc/technical-decisions.md 第 8 节）

## User Stories

### US-001: 项目骨架 + Config + Errors
**Description:** 作为开发者，我需要 Node.js 项目结构和基础模块，所有其他模块依赖它们。

**Acceptance Criteria:**
- [ ] `package.json` 含 `"type": "module"`、`"engines": {"node": ">=18.0.0"}`、`"packageManager": "bun@1.1.0"`
- [ ] dependencies: express, better-sqlite3, ejs, commander, js-yaml
- [ ] devDependencies: typescript, vitest, supertest, @types/*, biome
- [ ] scripts: start(`bun run src/cli.ts`), test(`vitest run`), check(`tsc --noEmit && biome check src/`)
- [ ] `tsconfig.json`: strict, esModuleInterop, moduleResolution=bundler, target=ES2022, outDir=dist
- [ ] `biome.json`: formatter(indentStyle=space, indentWidth=2), linter(recommended)
- [ ] `src/config.ts` 实现 `LoomerConfig` 类：baseBranch, claudePath, claudeArgs, defaultPort(3000), defaultTimeoutMinutes(30), maxConcurrent(5), stateDir("~/.loomer"), skillPrefix(true), mergeStrategy("auto"), createPr(false), autoMergeRules
- [ ] `Config.load(configPath?, overrides?)` 加载全局 ~/.loomer/config.json + 项目 .loomer.json（后者覆盖前者）+ CLI overrides
- [ ] `src/errors.ts` 实现 LoomerError 层次：DirtyWorktreeError, BranchConflictError, InvalidNameError, AgentNotFoundError, MergeError(conflictFiles?), PlanFormatError, DAGValidationError, PlanNotFoundError, PlanAlreadyActiveError
- [ ] `vitest.config.ts` 配置
- [ ] `bun test` 运行 tests/ 全部通过
- [ ] 详见 doc/api-spec.md 第 1-2 节

---

### US-002: StateStore — SQLite WAL 持久化
**Description:** 作为开发者，我需要 SQLite WAL 模式的状态存储，替代 Python 的 JSON + fcntl.flock。

**Acceptance Criteria:**
- [ ] `src/state.ts` 实现 `StateStore` 类，构造函数接受 `(config, repoPath)`
- [ ] better-sqlite3 同步 API，启用 WAL 模式 + busy_timeout=5000
- [ ] agents 表：name(PK), status, branch, prompt, worktree, started_at, pid, exit_code, risk_assessment(JSON), last_output, pr_url, archived, depends_on(JSON), plan
- [ ] plans 表：name(PK), max_concurrent, tasks(JSON), created_at
- [ ] 核心方法：load/save/updateAgent/updateAgentStatus/removeAgent/getAgent/getPlan/setPlan/clearPlan/getPendingAgents/getRunningCount
- [ ] getAgent() 对缺失字段防御性处理（返回默认值而非 throw，Dogfooding 教训：旧数据可能缺字段）
- [ ] Archive 方法：archiveAgent/getActiveAgents/getArchived
- [ ] repo 路径隔离：SHA256(repoPath)[:12] 作为子目录
- [ ] tests/state.test.ts 全部通过
- [ ] 详见 doc/api-spec.md 第 3 节、doc/technical-decisions.md 第 1 节

---

### US-003: WorkspaceManager — Git Worktree CRUD
**Description:** 作为开发者，我需要工作区管理器来创建/删除 git worktree。

**Acceptance Criteria:**
- [ ] `src/workspace.ts` 实现 `WorkspaceManager` 类
- [ ] `create(name, baseBranch?)` → `{ name, path, branch }`：`git worktree add <path> -b <name> <baseBranch>`
- [ ] `remove(name)`：`git worktree remove --force <path>` + `git branch -D <name>`
- [ ] `listAll()` → `Workspace[]`
- [ ] `exists(name)` → boolean
- [ ] 使用 `child_process.execSync`
- [ ] tests/workspace.test.ts 全部通过
- [ ] 详见 doc/api-spec.md 第 7 节

---

### US-004: SafetyChecks — 风险分级审查
**Description:** 作为开发者，我需要安全检查和风险评估模块，实现 6 个风险信号和 3 种 merge 策略。

**Acceptance Criteria:**
- [ ] `src/safety.ts` 实现 `SafetyChecks` 类
- [ ] `checkGitClean()` → boolean（`git status --porcelain`）
- [ ] `checkGitignore(dir)` → boolean（`git check-ignore -q`）
- [ ] `checkBranchExists(name)` → boolean（`git branch --list`）
- [ ] `static validateName(name)` → throws InvalidNameError（`/^[a-zA-Z0-9_-]+$/`, ≤64）
- [ ] `assessRisk(name, worktreePath, mergeStrategy, rules, baseBranch?)` → RiskAssessment
- [ ] 6 个风险信号：file_count, line_count, new_files, public_modules, conflict, test
- [ ] merge_strategy='always' → 全部 HIGH；'never' → 全部 LOW
- [ ] diff 范围：`<baseBranch>...HEAD`
- [ ] conflict 信号：`git merge --no-commit --no-ff` + `git merge --abort`
- [ ] 任一 HIGH → 整体 HIGH
- [ ] tests/safety.test.ts 全部通过
- [ ] 详见 doc/risk-assessment.md、doc/api-spec.md 第 6 节

---

### US-005: PlanParser + DAGValidator
**Description:** 作为开发者，我需要计划解析和 DAG 验证模块，支持 plan.md 和 prd.json 两种输入。

**Acceptance Criteria:**
- [ ] `src/plan.ts` 实现 PlanParser + DAGValidator
- [ ] `PlanParser.parse(path)` 解析 plan.md YAML frontmatter → PlanSpec（用 js-yaml）
- [ ] `PlanParser.fromPrdJson(path, maxConcurrent?)` 解析 prd.json → PlanSpec
- [ ] prompt 来源：优先 userStory.description，回退 title
- [ ] `DAGValidator.validate(spec)` 4 规则：ID 合法、无重复、无缺引用、无环（Kahn 算法）
- [ ] TaskSpec: `{ id, prompt, dependsOn }`
- [ ] PlanSpec: `{ name, maxConcurrent, tasks }`
- [ ] tests/plan-parser.test.ts 全部通过
- [ ] 详见 doc/dag-scheduling.md、doc/api-spec.md 第 8 节

---

### US-006: ProcessManager — Spawn + Stream-JSON
**Description:** 作为开发者，我需要进程管理器，用 child_process.spawn 替代 Python Popen，实时 pipe stream-json。

**Acceptance Criteria:**
- [ ] `src/process.ts` 实现 `ProcessManager` 类
- [ ] `start(name, worktreePath, prompt)` — spawn kscc with `--output-format stream-json --verbose --include-partial-messages`
- [ ] skill 前缀注入（config.skillPrefix）
- [ ] stdin pipe 传递 prompt（无临时文件）
- [ ] stdout `on('data')` 实时解析 stream-json 事件
- [ ] `stderr` → warning log
- [ ] `on('exit')` 回调写 exit_code（通过回调参数，不直接 import StateStore）
- [ ] `stop(name)` — kill + wait 收割
- [ ] `isAlive(name)` → boolean
- [ ] `getRecentOutput(name, lines?)` — 解析 stream-json 提取 assistant 文本
- [ ] `getPid(name)` → number | null
- [ ] `listProcesses()` → ProcessInfo[]
- [ ] `_parseStreamJson(lines)` 静态方法：解析 content_block_delta + result 事件
- [ ] tests/process.test.ts 全部通过
- [ ] 详见 doc/technical-decisions.md 第 2-3 节、doc/api-spec.md 第 4 节

---

### US-007: StatusDetector — 9 种状态 + 转换
**Description:** 作为开发者，我需要状态检测器，实现 9 种状态判断和 transition callback。

**Acceptance Criteria:**
- [ ] `src/status.ts` 实现 `StatusDetector` 类
- [ ] Status enum: PENDING, RUNNING, DONE, CRASHED, CONFLICTED, STALE, REVIEW, ACCEPTED, REJECTED
- [ ] `setTransitionCallback(cb)` — 设置回调
- [ ] `getStatus(name)` 检测优先级：终态直返 → STALE(超时) → isAlive(同实例) → isPidAlive(跨实例) → exit_code → poll → worker.log fallback → CRASHED
- [ ] exit_code !== 0 必须 short-circuit 到 CRASHED（Dogfooding 教训 8.6）
- [ ] `getRecentOutput(name, lines?)` — 优先 process 输出，回退 state.last_output
- [ ] `getDiff(name, mode?)` — `git diff --stat` 或 `git diff`
- [ ] `isPidAlive(pid)` — `process.kill(pid, 0)`
- [ ] `_fireTransition(name, status)` — 触发回调，异常 catch + warning
- [ ] tests/status.test.ts 全部通过
- [ ] 详见 doc/state-machine.md、doc/api-spec.md 第 5 节

---

### US-008: LoomerApp — 核心编排
**Description:** 作为开发者，我需要应用核心，编排所有模块实现 agent 生命周期和风险分级 merge。

**Acceptance Criteria:**
- [ ] `src/app.ts` 实现 `LoomerApp` 类
- [ ] 构造函数自动检测 baseBranch（`git rev-parse --abbrev-ref HEAD`）
- [ ] `start(name, prompt)` — safety check + workspace.create + process.start + state.updateAgent
- [ ] `done(name)` — assessRisk(merge前) + _mergeAgent + process.stop + 分级决策(LOW→ACCEPTED, HIGH→REVIEW+PR) + _triggerDepResolution
- [ ] `_mergeAgent(name, worktreePath)` — git add -A + 检查是否有变更(`git diff --cached --quiet`) + 自动 commit（agent 可能不 commit，Dogfooding 教训）+ git merge，冲突→CONFLICTED
- [ ] `_createPr(name, worktreePath)` — `gh pr create`，失败不阻塞
- [ ] `accept(name)` — REVIEW→ACCEPTED + workspace.remove
- [ ] `reject(name)` — REVIEW→REJECTED + workspace.remove
- [ ] `kill(name, clean?)` — process.stop + DONE/clean→removeAgent
- [ ] `retry(name)` — CRASHED/CONFLICTED→RUNNING
- [ ] `_startPending(name)` — PENDING→RUNNING（跳过 safety check）
- [ ] `status()` → AgentInfo[]（实时检测）
- [ ] `log(name, lines?)` → output
- [ ] `_countPlanProgress(plan)` — 覆盖所有状态含 stale/review/rejected
- [ ] `planDag()` — `{ nodes, edges }`
- [ ] `runPlan(path?, prdPath?)` — 启动前清除旧计划残留数据（state.clearPlan + 清理旧 agent），Dogfooding 教训
- [ ] 构造函数记录 `this.repoPath = process.cwd()`，所有 git 命令用 worktree 绝对路径（避免 CWD 问题），Dogfooding 教训
- [ ] transition callback 连接 statusDetector → _triggerDepResolution
- [ ] tests/app.test.ts 全部通过
- [ ] 详见 doc/risk-assessment.md done()流程、doc/api-spec.md 第 9 节

---

### US-009: PlanExecutor — DAG 并行调度
**Description:** 作为开发者，我需要计划执行器，实现 DAG 依赖解析和并行任务启动。

**Acceptance Criteria:**
- [ ] `src/plan.ts` 扩展 PlanExecutor 类
- [ ] `registerTasks()` — 所有任务注册到 state：status=PENDING
- [ ] `onTaskDone(taskId)` — 检查 PENDING 依赖：REJECTED→级联REJECTED, DONE/ACCEPTED→依赖满足, 启动满足依赖的任务（尊重 maxConcurrent）
- [ ] `isPlanComplete()` — 全部终态
- [ ] `getProgress()` — { total, done, running, pending, crashed, conflicted, stale, review }
- [ ] LoomerApp.runPlan(path?, prdPath?) — 解析+验证+注册+创建worktree+启动root
- [ ] LoomerApp.planStatus() — 有 executor 用 executor，无则 _countPlanProgress
- [ ] tests/plan-executor.test.ts 全部通过
- [ ] 详见 doc/dag-scheduling.md、doc/api-spec.md 第 8 节

---

### US-010: CLI — Commander.js 子命令
**Description:** 作为用户，我需要命令行入口操作 loomer 的所有功能。

**Acceptance Criteria:**
- [ ] `src/cli.ts` 实现 Commander.js CLI
- [ ] 子命令：start, done, kill(--clean), retry, accept, reject, log(--lines), status(--all), serve(--port), plan run(--prd), plan status
- [ ] `start <name> --prompt <text>` 启动 agent
- [ ] `serve [--port 3000]` 启动 Express 服务器
- [ ] `status --all` 含 archived agent
- [ ] `plan run --prd <path>` 执行 PRD 计划
- [ ] 全局 --db 参数
- [ ] `#!/usr/bin/env node` shebang，`bin` 字段指向编译后入口
- [ ] tests/cli.test.ts 全部通过
- [ ] 详见 doc/api-spec.md 第 10 节

---

### US-011: Web API — Express REST + SSE
**Description:** 作为开发者，我需要 Express Web 层提供 REST API 和 SSE 实时推送。

**Acceptance Criteria:**
- [ ] `src/web.ts` 实现 `createApp(config?, app?)` 工厂函数
- [ ] REST 端点：GET /, GET /api/status(?archived), POST /api/start, GET /api/log/:name, GET /api/diff/:name, POST /api/done/:name, POST /api/kill/:name(?clean), POST /api/retry/:name, POST /api/accept/:name, POST /api/reject/:name
- [ ] Plan 端点：POST /api/plan/run, GET /api/plan/status, GET /api/plan/dag
- [ ] SSE：GET /api/events — 2s 轮询，只推送变化，15s 心跳
- [ ] 统一 LoomerError 错误处理 → 400 JSON
- [ ] 中间件：express.static, express.urlencoded, EJS
- [ ] tests/web.test.ts 全部通过（supertest）
- [ ] 详见 doc/web-and-sse.md、doc/api-spec.md 第 11 节

---

### US-012: Dashboard HTML — 仪表盘界面
**Description:** 作为用户，我需要浏览器仪表盘查看和操作 agent。

**Acceptance Criteria:**
- [ ] `views/index.ejs` 单页面仪表盘（纯 HTML + vanilla JS，无框架）
- [ ] Agent 列表：名称、状态徽章（9 种颜色）、分支、prompt 摘要、操作按钮
- [ ] 操作按钮按状态显示：RUNNING→Kill, DONE→Done, REVIEW→Accept/Reject, CRASHED→Retry
- [ ] 日志查看：点击 agent → 弹出最近输出
- [ ] Diff 查看：点击 → 弹出 git diff --stat
- [ ] DAG 可视化：计划执行时显示 DAG 图（nodes + edges）
- [ ] SSE 客户端：EventSource('/api/events')，状态变化自动刷新列表
- [ ] `public/style.css` 响应式布局
- [ ] Verify in browser
- [ ] 详见 doc/web-and-sse.md

---

### US-013: Daemon — 系统服务管理
**Description:** 作为开发者，我需要 daemon 模块支持 macOS launchd 和 Linux systemd。

**Acceptance Criteria:**
- [ ] `src/daemon/manager.ts` — DaemonBackend 抽象 + 平台自动检测
- [ ] `src/daemon/launchd.ts` — macOS: ~/Library/LaunchAgents/ plist 生成 + launchctl load/unload
- [ ] `src/daemon/systemd.ts` — Linux: ~/.config/systemd/user/ unit 生成 + systemctl enable/start/stop
- [ ] `src/daemon/metadata.ts` — DaemonMetadata: load/save/getPid/setPid/getStartedAt/markStopped/isRunning
- [ ] CLI 子命令：daemon install/uninstall/start/stop/status
- [ ] tests/daemon.test.ts 全部通过
- [ ] 详见 doc/api-spec.md 第 12 节

## Functional Requirements

- FR-1: Config.load() 三层覆盖：全局 ~/.loomer/config.json → 项目 .loomer.json → CLI overrides
- FR-2: StateStore 使用 SQLite WAL 模式，PRAGMA journal_mode=WAL, busy_timeout=5000
- FR-3: ProcessManager 使用 child_process.spawn + stdin pipe 传递 prompt
- FR-4: stream-json 解析：content_block_delta.text_delta + result[].text
- FR-5: StatusDetector 检测优先级：终态 → STALE(超时) → isAlive → isPidAlive → exit_code → poll → fallback → CRASHED
- FR-6: assessRisk() 必须在 _mergeAgent() 之前调用
- FR-7: diff 范围使用 `<baseBranch>...HEAD`
- FR-8: DAGValidator 4 规则：ID 合法、无重复、无缺引用、无环（Kahn）
- FR-9: PlanExecutor 级联拒绝：dep REJECTED → 子任务 REJECTED
- FR-10: SSE 只推送状态变化，15s 心跳
- FR-11: Archive 机制：默认不含已归档 agent，--all/?archived=true 含归档
- FR-12: _createPr() 失败不阻塞 done() 流程

## Non-Goals

- 不做多用户认证
- 不做 CI/CD Checks 集成
- 不做 Diff Viewer 增强（diff2html 等）
- 不做 Personalities（不同 agent 角色配置）
- 不做 WebSocket（SSE 足够）
- 不做 npm 发布（本地使用）
- 不做 esbuild 打包（开发态直接 `bun run`，不做独立二进制分发）

## Design Considerations

- 技术栈对齐 Claude Code（kscc）：TypeScript + ESM + Bun + Biome
- Bun 原生支持 TypeScript，无需 tsc 编译步骤即可运行
- `tsc --noEmit` 仅做类型检查（CI / `bun run check`），不做 emit
- Biome 统一 formatter + linter，替代 ESLint + Prettier
- EJS 模板语法接近 Jinja2，Python 迁移成本低

## Technical Considerations

- Node.js 18+ ESM，所有 src/ 文件使用 import/export，扩展名 .ts
- better-sqlite3 同步 API（比 async sqlite3 简单可靠）
- kscc 启动参数：`--output-format stream-json --verbose --include-partial-messages`
- Event loop 单线程无需 threading.Lock
- Bun 作为包管理器（`bun install`）和运行时（`bun run src/cli.ts`）
- 详见 doc/technical-decisions.md 全部 7 个决策

## Success Metrics

- `bun install && bun test` 全部通过（覆盖率 > 80%）
- `tsc --noEmit` 零错误
- `bun run src/cli.ts serve` 启动，浏览器访问 `http://localhost:3000` 仪表盘正常
- 完整 DAG 流程跑通：prd.json → plan run → 并行调度 → 风险分级 → merge/PR
- Wave 1 并行度 ≥ 5（6 个 US 同时启动）

## Open Questions

- Dashboard DAG 可视化用 Canvas/SVG/纯 CSS？（建议纯 CSS + flex，零依赖）
- Daemon logrotate 是否 v0.1 包含？（建议不含，v0.2 加）
- 是否需要 esbuild 打包为独立可执行文件？（建议 v0.1 不做）

## 任务拆分

### TS-001: 项目骨架 + Config + Errors
- 对应: US-001
- 依赖: 无
- 可并行: 是
- 分支: feat/skeleton

### TS-002: StateStore SQLite WAL
- 对应: US-002
- 依赖: TS-001
- 可并行: 是（TS-001 完成后）
- 分支: feat/state-sqlite

### TS-003: WorkspaceManager
- 对应: US-003
- 依赖: TS-001
- 可并行: 是（TS-001 完成后，与 TS-002/004/005/006/013 并行）
- 分支: feat/workspace

### TS-004: SafetyChecks 风险分级
- 对应: US-004
- 依赖: TS-001
- 可并行: 是（TS-001 完成后，与 TS-002/003/005/006/013 并行）
- 分支: feat/safety-checks

### TS-005: PlanParser + DAGValidator
- 对应: US-005
- 依赖: TS-001
- 可并行: 是（TS-001 完成后，与 TS-002/003/004/006/013 并行）
- 分支: feat/plan-parser

### TS-006: ProcessManager spawn + stream-json
- 对应: US-006
- 依赖: TS-001
- 可并行: 是（TS-001 完成后，与 TS-002/003/004/005/013 并行）
- 分支: feat/process-manager

### TS-007: StatusDetector 9 状态
- 对应: US-007
- 依赖: TS-002, TS-006
- 可并行: 否（等 TS-002 + TS-006 完成后可执行）
- 分支: feat/status-detector

### TS-008: LoomerApp 核心编排
- 对应: US-008
- 依赖: TS-002, TS-003, TS-004, TS-006, TS-007
- 可并行: 否（等所有核心模块完成后可执行）
- 分支: feat/app-core

### TS-009: PlanExecutor DAG 调度
- 对应: US-009
- 依赖: TS-005, TS-008
- 可并行: 否（等 TS-005 + TS-008 完成后可执行，可与 TS-010/011 并行）
- 分支: feat/plan-executor

### TS-010: CLI Commander.js
- 对应: US-010
- 依赖: TS-008
- 可并行: 否（等 TS-008 完成后可与 TS-009/011/013 并行）
- 分支: feat/cli

### TS-011: Web API Express + SSE
- 对应: US-011
- 依赖: TS-008
- 可并行: 否（等 TS-008 完成后可与 TS-009/010/013 并行）
- 分支: feat/web-api

### TS-012: Dashboard HTML 仪表盘
- 对应: US-012
- 依赖: TS-011
- 可并行: 否（等 TS-011 完成后可执行）
- 分支: feat/dashboard

### TS-013: Daemon 系统服务
- 对应: US-013
- 依赖: TS-001
- 可并行: 是（TS-001 完成后，与 TS-002/003/004/005/006 并行）
- 分支: feat/daemon
