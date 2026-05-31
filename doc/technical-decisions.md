# Loomer 关键技术决策

> Loomer 核心架构选型与 dogfooding 经验总结

## 1. 状态持久化：SQLite WAL

**SQLite WAL 模式**（better-sqlite3）
- 天然支持跨进程原子读写，无需文件锁
- WAL（Write-Ahead Logging）允许读写并发
- better-sqlite3 同步 API，天然线程安全（V8 单线程）

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

## 2. 进程管理：child_process.spawn

- `child_process.spawn(cmd, { stdio: ['pipe', 'pipe', 'pipe'] })`
- **stream-json pipe 实时解析**：stdout 是 Readable stream
- `on('data')` 实时解析 stream-json 事件，无需文件中转
- `on('exit')` 直接获取 exit code

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

## 4. 并发模型：事件循环单线程

- Node.js 单线程事件循环
- 无需线程锁（V8 单线程保证原子性）
- SQLite 事务替代文件锁
- spawn 的 'exit' 回调在事件循环中，无需同步

## 5. 三层配置覆盖

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

- Agent 数据新增 `archived: boolean` 字段
- `archiveAgent(name)` — 标记为已归档
- `getActiveAgents()` — 过滤 archived=false
- `getArchivedAgents()` — 只看 archived=true
- `status` 命令默认只显示活跃 agent，`--all` 含归档
- `GET /api/status?archived=false` 默认不含归档

## 7. Prompt 传递

- spawn stdin pipe 直接传递（Node.js 无 /proc 问题）
- 无需临时文件和清理逻辑

```typescript
child.stdin.write(prompt)
child.stdin.end()
```

## 8. Dogfooding 教训

> 来自 Loomer dogfooding 的真实经验。

### 8.1 stream-json 必须加 --verbose

**问题：** RTW-003/004/005 全部 CRASHED，原因是 spawn 只传了 `--output-format stream-json`，缺少 `--verbose` 和 `--include-partial-messages`。

**结果：** agent 执行完毕但 ProcessManager 无法解析输出，StatusDetector 判断为 CRASHED。

**修复：** 启动命令固定为：
```bash
claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
```

**设计要求：** ProcessManager.start() 中这 3 个参数不可配置、不可省略，硬编码到 cmd 列表中。

### 8.2 跨进程状态检测必须可靠

**问题：** CLI 启动的 agent 进程在 Web 服务重启后从 `_processes` 字典消失，`isAlive()` 返回 false，但进程实际仍在运行。

**修复：** StatusDetector 增加 PID 检测路径（`_is_pid_alive`），在 `ProcessManager.isAlive()` 返回 false 后尝试 `os.kill(pid, 0)`。

**设计要求：** `getStatus()` 检测优先级中，PID 检测必须在内存检查之后、exit_code 判断之前。

### 8.3 TS 编号用项目前缀避免跨计划冲突

**问题：** reading-tracker（TS-001~007）和 reading-tracker-web（如果也用 TS-001~007）在同一 state中共存时 ID 冲突。

**修复：** reading-tracker-web 使用 RTW-001~007 前缀。

**设计要求：** prd.json 中 `taskSplit[].id` 建议使用项目缩写前缀（如 LMR-001），避免跨计划 ID 冲突。PlanExecutor 不强制，但在 `/prd` skill 中推荐。

### 8.4 _plan_executor 重启后为 None 需兜底

**问题：** Web 服务重启后 `app._plan_executor = None`，`planStatus()` 无法返回正确进度。

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

**问题：** exit_code 判断在输出检查之后，导致 exit_code=1 的进程被误判为 DONE（输出有内容）。

**修复：** exit_code 检测 short-circuit 到 CRASHED（exit_code != 0 → 直接 CRASHED，不 fallthrough 到 worker.log）。

**设计要求：** `getStatus()` 中 exit_code 判断必须在输出 fallback 之前，且 exit_code !== 0 直接返回 CRASHED。

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

**问题：** 主进程启动后 CWD 可能变化（例如 shell 切换目录后 LoomerApp 仍在运行），导致 git 命令在错误目录执行。

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

### 8.11 WorkspaceManager 必须幂等 — 分支/worktree/目录残留容忍

**问题：** `loomer plan run` 第二次运行时，`git worktree add -b TS-001` 失败（分支已存在）；worktree 目录残留时也崩溃。

**修复：** WorkspaceManager.create() 三重幂等：
1. worktree 已注册 → 直接返回
2. 目录残留但非 worktree → `rm -rf` + `git worktree prune` → 重新创建
3. 分支已存在 → `git worktree add <path> <name>`（不带 `-b`）

**设计要求：** WorkspaceManager.create() 必须幂等。runPlan() 预创建和 start() 都调用 create()，双重调用不能崩溃。

### 8.12 子进程 PATH 必须包含 bun 等运行时路径

**问题：** ProcessManager spawn claude (kscc) 时，kscc 内部需要 bun 运行时但 `spawnSync bun ENOENT`。`~/.bun/bin` 不在默认 PATH 中。

**修复：** ProcessManager.start() 构建增强 PATH，追加 `~/.bun/bin`、`~/.local/bin`、`/usr/local/bin` 等常见 CLI 目录。

```typescript
const EXTRA_PATHS = [
  path.join(os.homedir(), ".bun", "bin"),
  path.join(os.homedir(), ".local", "bin"),
  "/usr/local/bin",
];
const env = { ...process.env };
const extraDirs = EXTRA_PATHS.filter(d => !env.PATH?.includes(d));
if (extraDirs.length > 0) {
  env.PATH = `${extraDirs.join(path.delimiter)}${path.delimiter}${env.PATH}`;
}
spawn(cmd, args, { cwd, stdio, env });
```

**设计要求：** ProcessManager.start() 必须构建增强 PATH 环境变量，不依赖父进程 PATH 包含所有运行时。→ 详见 [design-spec.md §3](design-spec.md)

### 8.13 startServer 必须捕获 EADDRINUSE

**问题：** 端口被占用时 Express listen 抛出 unhandled error event，LoomerApp 进程崩溃退出。

**修复：** startServer() 监听 server error 事件，EADDRINUSE 时优雅降级（warning log，不启动 dashboard，但不崩溃）。

```typescript
this.server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Web dashboard not started.`);
    this.server = null;
  } else {
    throw err;
  }
});
```

**设计要求：** Web 服务器启动失败不能导致整个 LoomerApp 崩溃。端口冲突时降级运行（仅 CLI 可用）。

### 8.14 _mergeAgent 必须在主仓库目录执行 merge

**问题：** `_mergeAgent()` 在 worktree 目录中执行 `git checkout master && git merge <name>`，但 worktree 的 master 和主仓库的 master 是不同的 HEAD。merge 结果只存在于 worktree 的 .git 链接中，worktree 清理后代码丢失。

**根因：** git worktree 中 `git checkout master` 切换的是 worktree 自身的分支指针，不影响主仓库工作目录。

**修复：** merge 操作改在主仓库中执行：

```typescript
// 旧（错误）：在 worktree 中 merge
execSync(`git checkout ${baseBranch}`, { cwd: worktreePath });
execSync(`git merge ${name}`, { cwd: worktreePath });

// 新（正确）：在主仓库中 merge
execSync(`git merge ${name}`, { cwd: this.repoPath });
```

**设计要求：** _mergeAgent() 的 merge 操作必须在主仓库目录（`this.repoPath`）执行，不能在 worktree 中执行。auto-commit 仍在 worktree 中（在 agent 分支上），但 merge 到主分支必须在主仓库。→ 详见 [risk-assessment.md](risk-assessment.md)

### 8.15 _mergeAgent "无变更"判断必须用 git status

**问题：** `git diff --cached --quiet` 在 agent 已自行 commit 时成功（staged 无 diff），导致 _mergeAgent 跳过 commit 和 merge，代码丢失。

**根因：** `git diff --cached` 只看暂存区与 HEAD 的差异。如果 agent 已经 `git commit`，暂存区与 HEAD 相同，diff 为空。

**修复：** 用 `git status --porcelain` 判断是否有未提交变更（包括未暂存和已暂存）：

```typescript
// 旧（不可靠）：
execSync("git diff --cached --quiet", { cwd: worktreePath });
return; // 无变更

// 新（可靠）：
const statusOutput = execSync("git status --porcelain", { cwd: worktreePath }).trim();
if (!statusOutput) return; // 真正无变更
```

**设计要求：** _mergeAgent() 判断"是否有变更"必须用 `git status --porcelain`，不能用 `git diff --cached --quiet`。→ 详见 [risk-assessment.md](risk-assessment.md)

### 8.16 Agent prompt 必须包含 acceptance criteria

**问题：** kscc 在非交互模式 (`-p`) 运行时，prompt 只有一句话描述，agent 不知道具体要做什么，用 AskUserQuestion 提问后无人回答，直接结束（exit_code=0），实际没写代码。

**根因：** `PlanParser.fromPrdJson()` 只取 `userStory.description` 作为 prompt，丢弃了 `acceptanceCriteria`。非交互模式下 agent 无法获得足够上下文。

**修复：** 在 prompt 中注入 acceptance criteria + 禁止提问指令：

```typescript
const promptParts = [basePrompt];
if (criteria.length > 0) {
  promptParts.push("\n\nAcceptance Criteria:");
  for (const c of criteria) promptParts.push(`- ${c}`);
}
promptParts.push("\n\nImportant: Do NOT ask clarifying questions. Implement based on the criteria above. Commit all changes.");
```

**设计要求：** PlanParser.fromPrdJson() 生成的 prompt 必须包含 userStory.acceptanceCriteria 全部条目，并附加"不要提问，直接实现"指令。非交互模式的 agent 没有人回答 AskUserQuestion。→ 详见 [dag-scheduling.md](dag-scheduling.md)

### 8.17 依赖任务启动前必须 rebase 到最新主分支

**问题：** 依赖任务（如 TS-002 依赖 TS-001）的 worktree 基于旧 master 创建，TS-001 完成后 master 已有新代码，但 TS-002 的 worktree 没有这些代码，导致 agent 缺少依赖实现。

**修复：** start() 中创建 worktree 后，执行 `git rebase <baseBranch>` 获取最新主分支代码：

```typescript
try {
  execSync(`git rebase ${baseBranch}`, { cwd: ws.path, stdio: ["pipe", "pipe", "pipe"] });
} catch {
  try { execSync("git rebase --abort", { cwd: ws.path, stdio: ["pipe", "pipe", "pipe"] }); } catch {}
}
```

**设计要求：** start() 创建 worktree 后必须 rebase 到最新 baseBranch。rebase 失败时中止 rebase（让 agent 从干净状态开始），不阻塞启动。→ 详见 [dag-scheduling.md](dag-scheduling.md)

### 8.18 Web DAG 必须用 SVG 拓扑可视化

**问题：** Loomer DAG 用 flex-wrap div 渲染，只是带颜色徽章 + 文本边列表，无空间布局、无箭头、无拓扑排序。DAG 必须用 SVG 拓扑可视化。

**修复：** 重写 DAG 渲染为 SVG：
- BFS 拓扑分层确定节点 y 坐标
- 同层节点均匀分布确定 x 坐标
- 贝塞尔曲线连接依赖边 + 箭头 marker
- 节点颜色按状态编码

**设计要求：** Web 仪表盘 DAG 面板必须用 SVG 渲染，支持拓扑分层、有向边（箭头）、颜色编码。→ 详见 [web-and-sse.md](web-and-sse.md)

### 8.19 Plan 进度必须有进度条

**问题：** Plan 进度只显示文本 "total: X | running: Y | done: Z"，无进度条和百分比。

**修复：** 添加进度条 DOM + CSS 动画：

```html
<div class="dag-progress-track"><div id="dag-progress-bar" class="dag-progress-bar"></div></div>
<span id="dag-progress-pct">0%</span>
```

**设计要求：** Plan 面板必须显示进度条（带动画）和完成百分比。→ 详见 [web-and-sse.md](web-and-sse.md)

### 8.20 Agent 操作按钮必须覆盖所有状态

**问题：** DONE/CRASHED/STALE/ACCEPTED/REJECTED 状态无操作按钮。后端路由已存在（/api/done, /api/retry, /api/kill?clean=1），但前端 ACTIONS map 全部空数组。

**修复：** 补全 ACTIONS 映射：

| 状态 | 操作 | 后端路由 |
|------|------|---------|
| DONE | Merge | POST /api/done/:name |
| CRASHED | Retry | POST /api/retry/:name |
| STALE | Retry | POST /api/retry/:name |
| 非RUNNING/PENDING | Delete | POST /api/kill/:name?clean=1 |

**设计要求：** Web 仪表盘操作按钮必须与后端路由对齐。DONE 有 Merge，CRASHED/STALE 有 Retry，所有非活跃状态有 Delete（clean=1）。→ 详见 [web-and-sse.md](web-and-sse.md)

### 8.21 Plan 统计必须有可视化色点

**问题：** Plan 统计只有文本，一眼无法区分状态分布。

**修复：** 添加 stat-dot 色点元素（.dot-done, .dot-running, .dot-crashed 等），每个状态用独特颜色点 + 数字。

**设计要求：** Plan 面板统计必须用色点 + 标签展示，不能只有文本。→ 详见 [web-and-sse.md](web-and-sse.md)

### 8.22 LoomerApp 需要静态工厂方法

**问题：** CLI 入口 `new LoomerApp(config)` 只传 1 个参数，但构造函数需要 4-6 个参数（config, state, processManager, workspaceManager, [iStateStore], [repoPath]）。

**修复：** 添加 `LoomerApp.create(config, repoPath?)` 静态工厂方法，内部创建 StateStore、ProcessManager、WorkspaceManager。

**设计要求：** LoomerApp 必须提供 `create()` 静态工厂方法供 CLI 使用，构造函数保留给测试（依赖注入）。

