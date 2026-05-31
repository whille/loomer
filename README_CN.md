# Loomer — 从 PRD 到代码的自动化织机

Loomer 是一个开源的 AI coding agent 编排工具。从 PRD 出发，自动拆分任务、DAG 并行调度、风险分级审查、自动 merge/创建 PR。

**核心隐喻：** 织布机（loom）— PRD 是经线，agent 是纬线，DAG 是编织图案，审查门禁是质检站。

## 与 conductor-ui 的关系

Loomer 是 [conductor-ui](https://github.com/WillBrennan/conductor-ui)（Python，2,657 行核心代码）的 Node.js 重写，并在架构上做了关键改进：

| 维度 | conductor-ui | Loomer |
|------|-------------|--------|
| 入口 | 手动创建 agent | PRD 自动拆分 → DAG 调度 |
| 审查 | 人看所有 diff | 风险信号自动分级，人只看 HIGH |
| 平台 | 仅 macOS | macOS + Linux |
| 开源 | 闭源 | 完全开源 |
| 流水线 | 无 | `/prd` → prd.json → `loomer plan run --prd` → DAG → 审查 → merge/PR |

## 主要功能

### PRD 驱动 DAG 并行调度

在 `prd.json` 中定义任务，Loomer 解析后验证依赖图（无环、无缺引用），将无依赖的任务并行启动，上限为 `maxConcurrent`。任务完成后立即解锁下游依赖。

```
PRD → /prd skill → prd.json → loomer plan run --prd prd.json → DAG 验证 → 并行调度 → 风险审查 → merge/PR
```

### 风险分级审查

merge 前自动评估 6 个风险信号：

| 信号 | HIGH 条件 |
|------|----------|
| `file_count` | 改动文件数 > `maxFiles`（默认 5） |
| `line_count` | 改动行数 > `maxLines`（默认 200） |
| `new_files` | 创建了新文件 |
| `public_modules` | 修改了共享模块（路径含 `lib/`、`core/`、`src/`） |
| `conflict` | 检测到 merge 冲突 |
| `test` | 有代码改动但未修改测试文件 |

任一信号 HIGH → 整体 HIGH → 进入 REVIEW（需人工 accept/reject）。全部 LOW → 自动 merge → ACCEPTED。

三种 merge 策略：`auto`（默认）、`always`（全部 REVIEW）、`never`（全部 ACCEPTED）。

### Auto-Done

当 agent 进程退出（exit_code=0）时，Loomer 自动触发 `done()` 流程：风险评估 → merge → 分级决策 → 清理。LOW 风险改动无需人工干预。

### Merge 冲突自动解决

merge 冲突时，Loomer 先尝试按文件类型自动解决，失败才抛给人：

| 文件类型 | 自动解决策略 |
|---------|-------------|
| `package.json` | 合并两边的 dependencies（取并集） |
| `src/*.ts` 源码 | 识别 import/export/类定义，按顺序拼接（ours 前 theirs 后） |
| `*config*` 配置文件 | 深合并（ours 为基准叠 theirs 新增 key） |
| 其他 | 不自动解决 → CONFLICTED（保留供手动处理） |

自动解决后必须通过验证（`tsc --noEmit` / `biome check` / `vitest run`），验证失败则回退到 CONFLICTED。

### 常驻主进程架构

Loomer 使用 SQLite WAL 模式持久化状态，CLI 和 Web 可跨进程共享同一状态存储。事件循环单线程模型无需线程锁 — SQLite 事务天然处理跨进程原子性。

## 架构

```
┌──────────────────────────────────────────────────────┐
│                    CLI (Commander.js)                 │
│  start / done / kill / retry / accept / reject / ... │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│                 LoomerApp（核心编排器）                  │
│  ┌───────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │ Workspace │ │ SafetyChecks │ │ ProcessManager │  │
│  │  Manager  │ │ （风险分级）  │ │ (spawn+pipe)   │  │
│  └───────────┘ └──────────────┘ └────────────────┘  │
│  ┌───────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │   State   │ │    Status    │ │  PlanParser +  │  │
│  │  Store    │ │  Detector    │ │  PlanExecutor   │  │
│  │ (SQLite)  │ │ （9 种状态）  │ │ （DAG 调度）    │  │
│  └───────────┘ └──────────────┘ └────────────────┘  │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│          Express Web + SSE（实时仪表盘）                │
│  REST API: /api/status, /api/start, /api/done, ...   │
│  SSE: /api/events（只推变化 + 心跳保活）                │
└──────────────────────────────────────────────────────┘
```

## 状态机

9 种状态，严格的检测优先级：

```
PENDING ──start()──→ RUNNING
                      │
                      ├── timeout ──→ STALE ──kill()──→ DONE
                      │                        ──retry()──→ RUNNING
                      │
                      ├── exit_code=0 ──→ DONE ──done()──→ risk_check
                      │
                      ├── exit_code≠0 ──→ CRASHED ──retry()──→ RUNNING
                      │                           ──kill()──→ DONE
                      │
                      └── done()
                           │
                           ├── merge 冲突 ──→ CONFLICTED
                           │
                           └── merge 成功
                                │
                                ├── LOW + auto ──→ ACCEPTED
                                │
                                └── HIGH / always ──→ REVIEW ──accept()──→ ACCEPTED
                                                                ──reject()──→ REJECTED
```

**检测优先级**（设计不变量）：终态直返 → STALE（超时）→ 同实例 isAlive → 跨实例 PID 检测 → exit_code → spawn exit 事件 → 日志启发式 → CRASHED。

关键不变量：
- `exit_code !== 0` 必须 short-circuit 到 CRASHED（不 fallthrough 到启发式）
- 终态不再重新检测
- transition callback 驱动 DAG 依赖解析

## DAG 调度流程

```
prd.json → PlanParser.fromPrdJson() → PlanSpec
  → DAGValidator.validate()（4 规则：ID 合法、无重复、无缺引用、无环 Kahn 算法）
    → PlanExecutor.registerTasks()（全部 PENDING 写入状态存储）
      → 预创建所有 worktree（启动零延迟）
        → 启动 root 任务（dependsOn=[]，尊重 maxConcurrent）
          → onTaskDone() → 检查 PENDING 依赖
            → dep REJECTED → 级联 REJECT
            → dep DONE/ACCEPTED → 依赖满足 → 启动
```

级联拒绝：任一依赖 REJECTED，所有子任务也被 REJECTED（固定点迭代处理多层级传播）。

## done() 流程

```
Agent 退出（exit_code=0）
  → transition callback 触发 done(name)
    │
    ├── 1. assessRisk() — 必须在 merge 前！（否则 diff 为空）
    ├── 2. 持久化风险结果
    ├── 3. _mergeAgent()
    │     - git add -A（agent 可能不 commit）
    │     - git diff --cached --quiet（检查是否有变更）
    │     - git commit（如有变更）
    │     - git merge → 冲突 → 自动解决 → 验证 → 失败回退 → CONFLICTED
    ├── 4. 停止 agent 进程
    ├── 5. 分级决策：
    │     - auto + LOW → ACCEPTED + 清理 worktree
    │     - auto + HIGH → REVIEW + 创建 PR
    │     - always → REVIEW + 创建 PR
    │     - never → ACCEPTED
    └── 6. 触发 DAG 依赖解析
```

Worktree 清理规则：ACCEPTED/REJECTED → 清理；CONFLICTED/REVIEW → 保留。

## 快速开始

### 前置条件

- Node.js >= 18.0.0
- [Bun](https://bun.sh/)（包管理器 & 运行时）
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code)（kscc）
- Git

### 安装

```bash
git clone https://github.com/your-org/loomer.git
cd loomer
bun install
```

### 配置

三层覆盖：CLI 参数 > 项目 `.loomer.json` > 全局 `~/.loomer/config.json` > 内置默认。

全局配置（`~/.loomer/config.json`）：

```json
{
  "claudePath": "claude",
  "mergeStrategy": "auto",
  "maxConcurrent": 5,
  "defaultTimeoutMinutes": 30,
  "createPr": false,
  "autoMergeRules": {
    "maxFiles": 5,
    "maxLines": 200,
    "conflict": "review",
    "testFail": "auto"
  }
}
```

项目配置（仓库根目录 `.loomer.json`）：

```json
{
  "mergeStrategy": "never",
  "maxConcurrent": 3
}
```

### 执行计划

```bash
# 从 prd.json 文件执行
loomer plan run --prd tasks/prd.json

# 查看计划进度
loomer plan status
```

### CLI 命令

```bash
loomer start <name> --prompt <text>   # 启动 agent
loomer done <name>                     # 风险分级 merge
loomer kill <name> [--clean]           # 终止 agent（--clean 删除数据）
loomer retry <name>                    # 从 CRASHED/CONFLICTED 重试
loomer accept <name>                   # 通过 REVIEW 的 agent
loomer reject <name>                   # 拒绝 REVIEW 的 agent
loomer log <name> [--lines 50]         # 查看 agent 输出
loomer status [--all]                  # 列出 agent（--all 含归档）
loomer serve [--port 3000]             # 启动 Web 仪表盘
loomer plan run --prd <path>           # 执行 PRD 计划
loomer plan status                     # 计划进度
loomer daemon install                  # 安装系统服务
loomer daemon start                    # 启动守护进程
```

### Web 仪表盘

```bash
loomer serve
# 打开 http://localhost:3000
```

仪表盘功能：
- Agent 列表，9 种颜色状态徽章
- 按状态显示操作按钮（Kill/Done/Accept/Reject/Retry）
- 日志查看（点击 agent → 弹出最近输出）
- Diff 查看（点击 → git diff --stat）
- 计划执行时显示 DAG 可视化
- SSE 自动刷新（只推变化 + 15s 心跳保活）

### REST API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/status?archived=false` | 列出 agent |
| POST | `/api/start` | 创建 agent（`{name, prompt}`） |
| GET | `/api/log/:name?lines=50` | Agent 输出 |
| GET | `/api/diff/:name?mode=stat` | Git diff |
| POST | `/api/done/:name` | 风险分级 merge |
| POST | `/api/kill/:name?clean=0` | 终止 agent |
| POST | `/api/retry/:name` | 重试 agent |
| POST | `/api/accept/:name` | 通过 agent |
| POST | `/api/reject/:name` | 拒绝 agent |
| GET | `/api/events` | SSE 实时推送 |
| POST | `/api/plan/run` | 执行计划（`{path}` 或 `{prdPath}`） |
| GET | `/api/plan/status` | 计划进度 |
| GET | `/api/plan/dag` | DAG 结构 |

## 技术栈

- **语言：** TypeScript + ESM（Node.js 18+）
- **运行时/包管理：** Bun
- **Web：** Express + EJS
- **CLI：** Commander.js
- **数据库：** SQLite（better-sqlite3，WAL 模式）
- **进程管理：** child_process.spawn + stream-json pipe
- **测试：** Vitest
- **代码检查/格式化：** Biome

## 与 conductor-ui (Python) 的关键差异

| 模块 | Python 方案 | Loomer 方案 | 改进点 |
|------|-----------|-------------|--------|
| 进程管理 | subprocess.Popen + worker.log 文件 | child_process.spawn + stream-json pipe | 实时输出，无需轮询文件 |
| 状态持久化 | JSON 文件 + fcntl.flock | SQLite WAL 模式 | 跨平台，原子写入，无需 fcntl |
| 跨进程锁 | fcntl.flock（仅 Linux/Mac） | SQLite WAL + 乐观锁 | 跨平台 |
| Web 层 | Flask + Jinja2 | Express + EJS | 同生态，模板语法相似 |
| 配置 | 全局 config.json | 全局 + per-project `.loomer.json` | 多项目不冲突 |
| Agent 生命周期 | 无归档 | Archive 机制（active/archived 分离） | 列表清爽 |
| PR 创建 | 无 | `gh pr create` 自动创建 | REVIEW 时自动创建 PR |

## 设计文档

| 文档 | 内容 |
|------|------|
| [design-spec.md](doc/design-spec.md) | 设计不变量（11 模块）+ Dogfooding 教训 |
| [api-spec.md](doc/api-spec.md) | TypeScript API 签名（12 模块） |
| [state-machine.md](doc/state-machine.md) | 9 种状态 + 转换规则 + 检测优先级 |
| [risk-assessment.md](doc/risk-assessment.md) | 6 风险信号 + merge 策略 + done() 流程 |
| [dag-scheduling.md](doc/dag-scheduling.md) | prd.json 格式 + DAG 验证 + 依赖解析 |
| [technical-decisions.md](doc/technical-decisions.md) | 7 个 Python→Node 决策对比 + 10 条 dogfooding 教训 |
| [web-and-sse.md](doc/web-and-sse.md) | REST API + SSE + 仪表盘 |

## 许可证

MIT
