# Loomer API 规格

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

**新增：** createPr, per-project .loomer.json 覆盖，端口 3000

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

---

## 3. 状态 — `src/state.js`

```typescript
class StateStore {
  constructor(config: LoomerConfig, repoPath: string)

  // 核心方法
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

  // Archive 机制
  archiveAgent(name: string): void
  getActiveAgents(): Agent[]      // 过滤 archived
  getArchivedAgents(): Agent[]   // 只看 archived
}
```

**特性：**
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

**进程管理：** spawn + stdout pipe 实时消费 stream-json
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

PID 检测用 `process.kill(pid, 0)`。

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

6 个风险信号定义详见 [risk-assessment.md](risk-assessment.md)

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

git worktree 命令行操作，`child_process.execSync`。

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

**YAML 解析：** 使用 `js-yaml` 包。

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

  // Agent 生命周期
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

**特性：**
- `done()` 内自动 archive
- `_createPr()` 用 `child_process.execSync('gh pr create ...')`
- `_countPlanProgress` 覆盖所有状态含 stale/review/rejected

---

## 10. CLI — `src/cli.js`

```typescript
// 子命令
loomer start <name> --prompt <text>
loomer done <name>
loomer kill <name> [--clean]
loomer retry <name>
loomer accept <name>
loomer reject <name>
loomer log <name> [--lines 50]
loomer status [--all]      // --all 含 archived
loomer plan run --prd <path>  // 启动 LoomerApp 主进程 + Web 服务器
loomer plan status
```

**架构**: CLI 是 HTTP 薄客户端，通过 `LoomerClient` 与运行中的 LoomerApp 主进程通信。`plan run` 是唯一启动主进程的命令，其余子命令通过 HTTP 发给主进程。主进程未运行时 `status`/`log` 可直读 SQLite（只读），写操作提示先启动主进程。

**架构说明：** 无 serve 子命令（Web 由主进程自动启动），无 daemon 子命令（主进程即常驻进程）。新增 --all 显示 archived agent。

---

## 11. Web — `src/web.js`

```typescript
createApp(config?: LoomerConfig, app?: LoomerApp): Express

// REST API（+ 归档增强）
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

**状态端点：** 新增 archived 查询参数过滤。
