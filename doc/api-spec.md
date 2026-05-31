# Loomer API 规格 — 从 conductor-ui Python API 转换

> 来源：conductor-ui 17 个 Python 模块，2,657 行核心代码
> 转换原则：保持功能 1:1 对应，改进 Node.js 不擅长的部分（fcntl → SQLite WAL）

---

## 1. 配置 — `src/config.js`

```typescript
interface LoomerConfig {
  baseBranch: string          // 默认 ""，自动检测
  claudePath: string          // 默认 "claude"
  claudeArgs: string[]        // 额外参数
  defaultPort: number         // 默认 3000
  defaultTimeoutMinutes: number // 默认 30
  maxConcurrent: number       // 默认 5
  stateDir: string            // 默认 "~/.loomer"
  skillPrefix: boolean        // 默认 true
  mergeStrategy: "auto" | "always" | "never"
  createPr: boolean           // 默认 false
  autoMergeRules: {
    maxFiles: number          // 默认 5
    maxLines: number          // 默认 200
    conflict: "review" | "auto"
    testFail: "review" | "auto"
  }
}

// 加载：全局 ~/.loomer/config.json + 项目 .loomer.json（后者覆盖前者）
static load(configPath?: string, overrides?: Partial<LoomerConfig>): LoomerConfig
```

**Python 差异：** 新增 `createPr`，新增 per-project `.loomer.json` 覆盖，端口改为 3000。

---

## 2. 错误 — `src/errors.js`

```typescript
class LoomerError extends Error {}
class DirtyWorktreeError extends LoomerError {}
class BranchConflictError extends LoomerError {}
class InvalidNameError extends LoomerError {}
class AgentNotFoundError extends LoomerError {}
class MergeError extends LoomerError {
  conflictFiles?: string[]
}
class PlanFormatError extends LoomerError {}
class DAGValidationError extends LoomerError {}
class PlanNotFoundError extends LoomerError {}
class PlanAlreadyActiveError extends LoomerError {}
```

1:1 对应，无差异。

---

## 3. 状态 — `src/state.js`

```typescript
class StateStore {
  constructor(config: LoomerConfig, repoPath: string)

  // 核心方法（1:1 对应 Python）
  load(): State
  save(state: State): void
  updateAgent(name: string, fields: Record<string, unknown>): void
  updateAgentStatus(name: string, status: Status): void
  removeAgent(name: string): void
  getAgent(name: string): Agent
  getPlan(): PlanData | null
  setPlan(plan: PlanData): void
  clearPlan(): void
  getPendingAgents(): Agent[]
  getRunningCount(): number

  // Archive（新功能，Python 无）
  archiveAgent(name: string): void
  getActiveAgents(): Agent[]      // 过滤 archived
  getArchivedAgents(): Agent[]   // 只看 archived
}
```

**Loomer 差异：**
- 文件锁 → **SQLite WAL** 原子写入，跨平台
- 新增 `archiveAgent()` / `getActiveAgents()` / `getArchivedAgents()`
- Agent 数据新增 `archived: boolean` 和 `prUrl: string | null` 字段

SQLite Schema 详见 [technical-decisions.md §1](technical-decisions.md)

---

## 4. 进程管理 — `src/process.js`

```typescript
interface ProcessInfo {
  name: string
  pid: number | null
  alive: boolean
}

class ProcessManager {
  constructor(config: LoomerConfig)

  start(name: string, worktreePath: string, prompt: string): void
  stop(name: string): void
  isAlive(name: string): boolean
  getRecentOutput(name: string, lines?: number): string
  getPid(name: string): number | null
  listProcesses(): ProcessInfo[]

  // 内部
  _getWorkerLog(name: string): string
  _parseStreamJson(lines: string[]): string  // 静态
}
```

**Loomer 差异：**
- `child_process.spawn` 替代 Popen，stdout pipe 实时消费 stream-json
- stream-json 事件格式详见 [technical-decisions.md §3](technical-decisions.md)

---

## 5. 状态检测 — `src/status.js`

```typescript
enum Status {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  DONE = "DONE",
  CRASHED = "CRASHED",
  CONFLICTED = "CONFLICTED",
  STALE = "STALE",
  REVIEW = "REVIEW",
  ACCEPTED = "ACCEPTED",
  REJECTED = "REJECTED",
}

class StatusDetector {
  constructor(state: StateStore, process: ProcessManager, timeoutMinutes: number)

  setTransitionCallback(cb: (name: string, status: Status) => void): void
  getStatus(name: string): Status
  getRecentOutput(name: string, lines?: number): string
  getDiff(name: string, mode?: "stat" | "full"): string
}
```

1:1 对应。`_isPidAlive` 用 `process.kill(pid, 0)` (Node.js `process.kill` 语义相同)。

**RUNNING → 终态 转换规则（检测优先级）：**

1. `elapsed > timeoutMinutes * 60` → STALE
2. `processManager.isAlive()` → 仍为 RUNNING
3. `process.kill(pid, 0)` 成功 → 仍为 RUNNING（跨实例）
4. `exitCode === 0` → DONE
5. `exitCode !== 0` → CRASHED（short-circuit，不 fallthrough）
6. spawn 对象已 emit 'exit' + `code === 0` → DONE
7. spawn 对象已 emit 'exit' + `code !== 0` → CRASHED
8. 日志有内容且进程退出 → DONE
9. 以上都不满足 → CRASHED

详见 [state-machine.md](state-machine.md)

---

## 6. 安全检查 — `src/safety.js`

```typescript
enum RiskLevel { LOW = "LOW", HIGH = "HIGH" }

class RiskSignal {
  name: string
  level: RiskLevel
  detail: string
  toDict(): object
}

class RiskAssessment {
  level: RiskLevel
  signals: RiskSignal[]
  toDict(): object
}

class SafetyChecks {
  checkGitClean(): boolean
  checkGitignore(dir: string): boolean
  checkBranchExists(name: string): boolean
  static validateName(name: string): void  // throws InvalidNameError
  assessRisk(name: string, worktreePath: string, mergeStrategy: string, rules: object, baseBranch?: string): RiskAssessment
}
```

1:1 对应。6 个风险信号定义详见 [risk-assessment.md](risk-assessment.md)

详见 [risk-assessment.md](risk-assessment.md)

---

## 7. 工作区 — `src/workspace.js`

```typescript
interface Workspace {
  name: string
  path: string
  branch: string
}

class WorkspaceManager {
  constructor(config: LoomerConfig, root?: string)

  create(name: string, baseBranch?: string): Workspace
  remove(name: string): void
  listAll(): Workspace[]
  exists(name: string): boolean
}
```

1:1 对应。git worktree 命令行操作，`child_process.execSync`。

---

## 8. 计划 — `src/plan.js`

```typescript
interface TaskSpec {
  id: string
  prompt: string
  dependsOn: string[]
}

interface PlanSpec {
  name: string
  maxConcurrent: number
  tasks: TaskSpec[]
}

class PlanParser {
  static parse(path: string): PlanSpec
  static fromPrdJson(path: string, maxConcurrent?: number): PlanSpec
}

class DAGValidator {
  static validate(spec: PlanSpec): void  // throws PlanFormatError/DAGValidationError
}

class PlanExecutor {
  constructor(app: LoomerApp, spec: PlanSpec)

  registerTasks(): void
  onTaskDone(taskId: string): string[]  // 返回新启动的 task IDs
  isPlanComplete(): boolean
  getProgress(): { total, done, running, pending, crashed, conflicted, stale, review }
  // done = DONE + ACCEPTED; review = REVIEW + REJECTED
}
```

**Python 差异：** YAML 子集解析器 → 用 `js-yaml` 包替代手写解析器。

**DAGValidator 规则：**
1. task ID 合法：`^[a-zA-Z0-9_-]+$`，≤ 64 字符
2. 无重复 ID
3. 无缺失引用（dependsOn 中的 ID 必须存在）
4. 无环（Kahn 算法拓扑排序）

**prd.json 格式：**

```json
{
  "project": "feature-name",
  "userStories": [{ "id": "US-001", "description": "As a..., I want..." }],
  "taskSplit": [{ "id": "TS-001", "userStory": "US-001", "depends": [] }]
}
```

详见 [dag-scheduling.md](dag-scheduling.md)

---

## 9. 应用核心 — `src/app.js`

```typescript
class LoomerApp {
  constructor(config?: LoomerConfig, ...)

  // Agent 生命周期（1:1 对应 Python）
  start(name: string, prompt: string): void
  done(name: string): void     // 风险分级 merge + PR + archive
  accept(name: string): void
  reject(name: string): void
  kill(name: string, clean?: boolean): void
  retry(name: string): void

  // 计划
  runPlan(path?: string, prdPath?: string): PlanResult
  planStatus(): PlanProgress | null
  planDag(): DagData | null

  // 查询
  status(): AgentInfo[]
  log(name: string, lines?: number): string

  // 私有
  _createPr(name: string, worktreePath: string): string | null
  _mergeAgent(name: string, worktreePath: string): void
  _countPlanProgress(plan: object): PlanProgress
}
```

**Python 差异：**
- `done()` 内自动 archive
- `_createPr()` 用 `child_process.execSync('gh pr create ...')`
- `_countPlanProgress` 覆盖所有状态含 stale/review/rejected

---

## 10. CLI — `src/cli.js`

```typescript
// 子命令（1:1 对应 Python）
loomer start <name> --prompt <text>
loomer done <name>
loomer kill <name> [--clean]
loomer retry <name>
loomer accept <name>
loomer reject <name>
loomer log <name> [--lines 50]
loomer status [--all]      // --all 含 archived
loomer serve [--port 3000]
loomer plan run --prd <path>
loomer plan status

// Daemon 子命令
loomer daemon install
loomer daemon uninstall
loomer daemon start
loomer daemon stop
loomer daemon status
```

**Python 差异：** 新增 `--all` 显示 archived agent。

---

## 11. Web — `src/web.js`

```typescript
createApp(config?: LoomerConfig, app?: LoomerApp): Express

// REST API（1:1 对应 Python + 归档增强）
GET  /                          // dashboard
GET  /api/status?archived=false // 列表，默认不含 archived
POST /api/start                 // {name, prompt}
GET  /api/log/<name>?lines=50   // 输出
GET  /api/diff/<name>?mode=stat // diff
POST /api/done/<name>           // merge
POST /api/kill/<name>?clean=0   // 终止
POST /api/retry/<name>          // 重试
POST /api/accept/<name>         // 接受
POST /api/reject/<name>         // 拒绝
GET  /api/events                // SSE
POST /api/plan/run              // {path}
GET  /api/plan/status            // 计划进度
GET  /api/plan/dag               // DAG 结构
```

**Python 差异：** `status` 端点新增 `archived` 查询参数。

---

## 12. Daemon — `src/daemon/`

```typescript
// 抽象后端（1:1 对应 Python）
abstract class DaemonBackend {
  abstract install(): void
  abstract uninstall(): void
  abstract start(): void
  abstract stop(): void
  abstract status(): string  // "running" | "stopped" | "unknown"
}

class LaunchdBackend extends DaemonBackend { ... }   // macOS
class SystemdBackend extends DaemonBackend { ... }   // Linux

class DaemonManager {
  constructor(backend?: DaemonBackend)  // 自动检测平台
  install(): void
  uninstall(): void
  start(): void
  stop(): void
  status(): string
}

class DaemonMetadata {
  constructor(stateDir: string)
  load(): object
  save(data: object): void
  getPid(): number | null
  setPid(pid: number): void
  getStartedAt(): number | null
  markStopped(): void
  isRunning(): boolean
}
```

1:1 对应。

---

## 模块对照表

| # | Python 模块 | Node.js 模块 | 行数(Python) | 差异 |
|---|------------|--------------|-------------|------|
| 1 | config.py | config.js | 57 | +createPr, +per-project |
| 2 | errors.py | errors.js | 44 | 1:1 |
| 3 | state.py | state.js | 92 | +archive, fcntl→SQLite WAL |
| 4 | process.py | process.js | 156 | Popen→spawn, stream-json pipe |
| 5 | status.py | status.js | 163 | 1:1 |
| 6 | safety.py | safety.js | 130 | 1:1 |
| 7 | workspace.py | workspace.js | 56 | 1:1 |
| 8 | plan.py | plan.js | 287 | YAML→js-yaml |
| 9 | app.py | app.js | 455 | +archive, +createPr |
| 10 | cli.py | cli.js | 143 | +--all |
| 11 | web.py | web.js | 132 | +archived param |
| 12 | daemon/ | daemon/ | 271 | 1:1 |
| | **合计** | | **2,657** | |
