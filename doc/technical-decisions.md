# Loomer 关键技术决策

> 从 conductor-ui Python 实现到 Node.js loomer 的架构差异

## 1. fcntl.flock → SQLite WAL

### Python 方案
- `state.json` + `fcntl.flock(LOCK_EX)` 跨进程互斥
- `threading.Lock` 同进程线程互斥
- 锁顺序：先线程锁再文件锁（避免 AB/BA 死锁）
- 原子写入：`tmp.write() + tmp.rename()`
- 降级：fcntl 不可用时仅用 threading.Lock + warning

### Loomer 方案
- **SQLite WAL 模式**（better-sqlite3）
- 天然支持跨进程原子读写，无需文件锁
- WAL（Write-Ahead Logging）允许读写并发
- better-sqlite3 同步 API，天然线程安全（V8 单线程）

### 对比

| 维度 | Python fcntl | Loomer SQLite WAL |
|------|-------------|-------------------|
| 跨平台 | 仅 Linux/Mac | 全平台 |
| 并发读 | 阻塞（LOCK_EX） | WAL 允许并发读 |
| 数据完整性 | JSON + rename | SQLite ACID 事务 |
| 锁实现 | 3 层（threading + fcntl + atomic rename） | SQLite 内建 |
| 降级 | fcntl 不可用降级 | 无需降级 |

### SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PENDING',
  branch TEXT,
  prompt TEXT,
  worktree TEXT,
  started_at REAL,
  pid INTEGER,
  exit_code INTEGER,
  risk_assessment TEXT,  -- JSON
  last_output TEXT,
  pr_url TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT,       -- JSON array
  plan TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  name TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL DEFAULT 5,
  tasks TEXT NOT NULL,   -- JSON array
  created_at REAL NOT NULL
);

-- WAL 模式启用
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
```

## 2. subprocess.Popen → child_process.spawn

### Python 方案
- `subprocess.Popen(cmd, stdout=worker_log_file)`
- worker.log 文件写入（buffering=1 行缓冲）
- 后台监控线程 `proc.wait()` → 写 exit_code
- 读取输出：重新打开 worker.log + tail

### Loomer 方案
- `child_process.spawn(cmd, { stdio: ['pipe', 'pipe', 'pipe'] })`
- **stream-json pipe 实时解析**：stdout 是 Readable stream
- `on('data')` 实时解析 stream-json 事件，无需文件中转
- `on('exit')` 直接获取 exit code

### 对比

| 维度 | Python Popen | Loomer spawn |
|------|-------------|-------------|
| 输出方式 | 写 worker.log + 文件轮询 | Readable stream 实时消费 |
| 延迟 | 文件 I/O 延迟（行缓冲） | 毫秒级实时 |
| 中间件 | 无（二进制文件） | stream-json → 文本提取 |
| 僵尸进程 | `proc.wait()` 收割 | `child.on('exit')` 自动 |
| 临时文件 | conductor-prompt-* 需清理 | 无需临时文件 |

## 3. stream-json 解析协议

kscc 启动参数：

```bash
claude -p <prompt> \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
```

### stream-json 事件类型

| 事件类型 | 含义 | 文本来源 |
|---------|------|---------|
| `content_block_delta` | 增量文本 | `delta.text` (type=text_delta) |
| `result` | 最终结果 | `result[].text` (type=text) |

### 解析逻辑

```typescript
function parseStreamJson(lines: string[]): string {
  const textParts: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          textParts.push(event.delta.text || '')
        }
      } else if (event.type === 'result') {
        for (const block of event.result || []) {
          if (block.type === 'text') textParts.push(block.text || '')
        }
      }
    } catch { /* skip non-JSON lines */ }
  }
  return textParts.length ? textParts.join('') : lines.join('\n')
}
```

### Node.js 实时 pipe

```typescript
const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'])
const textChunks: string[] = []

child.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      // 提取增量文本...
    } catch { /* skip */ }
  }
})

child.stderr.on('data', (chunk) => { /* log warning */ })
child.on('exit', (code) => { /* write exit_code to state */ })
```

## 4. threading.Lock → 事件循环单线程

### Python
- 多线程：Flask + ProcessManager + monitor thread
- `threading.Lock` + `dict_lock` 管理 agent 级锁
- 需显式加锁保护共享状态

### Loomer
- Node.js 单线程事件循环
- 无需线程锁（V8 单线程保证原子性）
- SQLite 事务替代文件锁
- spawn 的 'exit' 回调在事件循环中，无需同步

## 5. per-project 配置覆盖

### Python
- 全局 `~/.conductor-ui/config.json` 单一配置

### Loomer
- 全局 `~/.loomer/config.json` — 用户级默认
- 项目 `.loomer.json` — 项目级覆盖（git 可追踪）
- CLI 参数 — 命令级覆盖
- 加载优先级：CLI > 项目 > 全局 > 内置默认

```typescript
static load(configPath?: string, overrides?: Partial<LoomerConfig>): LoomerConfig {
  const cfg = new LoomerConfig()  // 内置默认
  // 1. 加载全局 ~/.loomer/config.json
  // 2. 加载项目 .loomer.json（覆盖全局）
  // 3. 应用 CLI overrides
  return cfg
}
```

## 6. Archive 机制

### Python conductor-ui
- agent 状态保存在 state.json，无归档概念
- 列表始终显示所有 agent（含已完成的）

### Loomer
- Agent 数据新增 `archived: boolean` 字段
- `archiveAgent(name)` — 标记为已归档
- `getActiveAgents()` — 过滤 archived=false
- `getArchivedAgents()` — 只看 archived=true
- `status` 命令默认只显示活跃 agent，`--all` 含归档
- `GET /api/status?archived=false` 默认不含归档

## 7. Prompt 传递

### Python
- 写入临时文件 `conductor-prompt-{name}`
- Popen stdin=DEVNULL（避免 /proc 暴露）
- atexit 清理临时文件

### Loomer
- spawn stdin pipe 直接传递（Node.js 无 /proc 问题）
- 无需临时文件和清理逻辑

```typescript
child.stdin.write(prompt)
child.stdin.end()
```

## 8. Dogfooding 教训

> 来自 conductor-ui 两次 dogfooding（reading-tracker Python 7/7 ACCEPTED，reading-tracker-web Node.js 部分 CRASHED）的真实经验。

### 8.1 stream-json 必须加 --verbose

**问题：** RTW-003/004/005 全部 CRASHED，原因是 spawn 只传了 `--output-format stream-json`，缺少 `--verbose` 和 `--include-partial-messages`。

**结果：** agent 执行完毕但 ProcessManager 无法解析输出，StatusDetector 判断为 CRASHED。

**修复：** 启动命令固定为：
```bash
claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
```

**设计要求：** ProcessManager.start() 中这 3 个参数不可配置、不可省略，硬编码到 cmd 列表中。

### 8.2 跨进程状态检测必须可靠

**问题：** CLI 启动的 agent 进程在 Flask 重启后从 `_processes` 字典消失，`isAlive()` 返回 false，但进程实际仍在运行。

**修复：** StatusDetector 增加 PID 检测路径（`_is_pid_alive`），在 `ProcessManager.isAlive()` 返回 false 后尝试 `os.kill(pid, 0)`。

**设计要求：** `getStatus()` 检测优先级中，PID 检测必须在内存检查之后、exit_code 判断之前。

### 8.3 TS 编号用项目前缀避免跨计划冲突

**问题：** reading-tracker（TS-001~007）和 reading-tracker-web（如果也用 TS-001~007）在同一 state中共存时 ID 冲突。

**修复：** reading-tracker-web 使用 RTW-001~007 前缀。

**设计要求：** prd.json 中 `taskSplit[].id` 建议使用项目缩写前缀（如 LMR-001），避免跨计划 ID 冲突。PlanExecutor 不强制，但在 `/prd` skill 中推荐。

### 8.4 _plan_executor 重启后为 None 需兜底

**问题：** Flask 重启后 `app._plan_executor = None`，`planStatus()` 无法返回正确进度。

**修复：** `_countPlanProgress(plan)` 从 state 实际状态重新计数，不依赖 executor 对象。

**设计要求：** `planStatus()` 必须实现双路径：有 executor 用 executor.getProgress()，无则用 _countPlanProgress() 从 SQLite 重新统计。

### 8.5 worktree 清理时机：merge/accept/reject 后自动 remove

**问题：** 早期实现中 worktree 在 agent 终态后未清理，导致 `git worktree list` 越来越长。

**修复：** done()/accept()/reject() 成功后自动 `workspace.remove(name)`。

**设计要求：**
- `done()` LOW→ACCEPTED 后 remove worktree
- `accept()` 后 remove worktree
- `reject()` 后 remove worktree
- `CONFLICTED` 状态保留 worktree（供手动解决冲突）
- `REVIEW` 状态保留 worktree（供创建 PR）

### 8.6 exit_code 必须优先于 worker.log 启发式

**问题：** Python 版 exit_code 判断在 worker.log 检查之后，导致 exit_code=1 的进程被误判为 DONE（worker.log 有内容）。

**修复：** exit_code 检测 short-circuit 到 CRASHED（exit_code != 0 → 直接 CRASHED，不 fallthrough 到 worker.log）。

**设计要求：** `getStatus()` 中 exit_code 判断必须在 worker.log fallback 之前，且 exit_code !== 0 直接返回 CRASHED。

### 8.7 Agent 不 commit → _mergeAgent 必须自动 commit

**问题：** agent 执行完毕后可能未 `git commit`（只改了文件但没暂存提交），导致 `git merge` 时 diff 为空，风险分级全部 LOW（无改动），误判为安全。

**修复：** `_mergeAgent()` 必须：
1. `git add -A`（暂存所有改动）
2. `git diff --cached --quiet`（检查是否有变更）
3. 如有变更 → `git commit -m "feat: {name} auto-commit"`
4. 如无变更 → 跳过 commit

**设计要求：** done() 流程中 _mergeAgent() 的 auto-commit 步骤不可省略。

### 8.8 旧计划残留数据

**问题：** 上一次 `plan run` 异常终止后，state 中仍残留旧的 plan 和 agent 数据。新计划启动时 `PlanAlreadyActiveError` 阻塞，或 agent ID 冲突。

**修复：** `runPlan()` 启动前：
1. 检查 state.getPlan() 是否为 null
2. 如有残留 → `state.clearPlan()` + 清理旧 agent（status 非终态的标记为 CRASHED）
3. 然后正常启动新计划

**设计要求：** runPlan() 必须在注册新任务前清理旧数据，不能假设 state 为空。

### 8.9 Express CWD 问题

**问题：** Flask 启动后 CWD 可能变化（daemon 模式、supervisor 等），导致 git 命令在错误目录执行。

**修复：** LoomerApp 构造函数记录 `this.repoPath = process.cwd()`，所有 git 命令显式传 `cwd: worktreePath`（绝对路径），不依赖 CWD。

**设计要求：** ProcessManager.start() 的 `spawn({ cwd: worktreePath })` 和所有 `execSync('git ...', { cwd: ... })` 必须使用绝对路径。

### 8.10 Agent 数据缺字段防御

**问题：** 旧版 state.json 中 agent 可能缺少 `pid`、`started_at`、`worktree` 等字段，`agent.get("pid")` 返回 None，后续代码 `.pid` 或算术运算 crash。

**修复：** 所有读取 agent 字段的地方使用防御性访问：
```typescript
const pid = agent.pid ?? null
const startedAt = agent.started_at ?? 0
const worktree = agent.worktree ?? ''
```

**设计要求：** StateStore.getAgent() 返回的对象对缺失字段提供默认值，或调用方必须用 `??` 防御。

