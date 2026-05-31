# Loomer 设计主线 — 从约束到实现

> 本文档是 loomer 实现的入口和线索。只记录**设计不变量**（what & why），不固定实现方式（how）。
> 每个模块的实现者用 Node.js 自由选择 how，但必须满足这里记录的约束。

## 阅读顺序

```
本文档（设计主线）→ 各子文档（展开约束细节）→ api-spec.md（TypeScript 接口签名）
```

---

## 1. 配置 — 三层覆盖

**设计约束**: 用户配置分三级，高优先级覆盖低优先级。

| 级别 | 位置 | 生命周期 |
|------|------|---------|
| 内置默认 | 代码中 | 永久 |
| 全局 | `~/.loomer/config.json` | 跨项目 |
| 项目 | `.loomer.json` | 单项目 |
| CLI 参数 | 命令行 | 单次调用 |

**不变量**: CLI > 项目 > 全局 > 内置。未知 key 静默忽略。`state_dir` 需要 `~` 展开。

**实现自由**: 配置文件格式、加载顺序的具体代码。

→ 详见 [api-spec.md §1 Config](api-spec.md)

---

## 2. 状态持久化 — 跨进程原子读写

**设计约束**:

1. **唯一真相源**: agent 状态只有一个权威存储，所有组件读写同一份数据
2. **跨进程安全**: CLI 和 Web 可能同时运行，读写不能丢失更新
3. **per-repo 隔离**: 不同 git 仓库的状态互不可见
4. **重启恢复**: Web 服务重启后，能从持久化存储重建全部状态
5. **防御性读取**: 旧版本数据可能缺字段，读取必须容错

**可选方案**: SQLite WAL / JSON+file-lock / levelDB / 其他

**不变量**: 无论用什么存储，必须满足以上 5 条约束。

→ 详见 [technical-decisions.md §1](technical-decisions.md)

---

## 3. 进程管理 — agent 生命周期

**设计约束**:

1. **独立隔离**: 每个 agent 在独立 git worktree 中执行，互不干扰
2. **prompt 注入**: skill 前缀（TDD/review/系统调试规则）可配置开关
3. **输出实时可读**: agent 输出必须实时解析，不能等进程结束后再读
4. **exit_code 权威**: 进程退出码是 DONE/CRASHED 判断的第一权威来源
5. **monitor 回写**: 进程退出时必须将 exit_code 写入状态存储（供跨实例检测）
6. **PATH 兼容**: 确保 claude CLI 的运行时（bun 等）在 PATH 中
7. **WorkspaceManager 幂等**: create() 必须容忍已存在的 worktree/分支/目录残留
8. **非交互 prompt 完整性**: prompt 必须包含 acceptance criteria + "不要提问"指令，避免 agent 因信息不足进入交互式等待

**可选方案**: child_process.spawn + stdout pipe 实时消费 / 其他

**不变量**: prompt 传递方式不必固定（argv / stdin / 临时文件均可），但必须保证：(a) prompt 不泄漏到 /proc 或 ps，(b) 进程退出时 exit_code 写入状态存储。

→ 详见 [technical-decisions.md §2-3](technical-decisions.md)

---

## 4. 状态机 — 9 种状态 + 检测优先级

**设计约束**:

1. **9 种状态**: PENDING / RUNNING / DONE / CRASHED / CONFLICTED / STALE / REVIEW / ACCEPTED / REJECTED
2. **终态不检测**: 一旦进入终态（DONE/CRASHED/CONFLICTED/STALE/REVIEW/ACCEPTED/REJECTED），直接返回
3. **STALE 检测**: 运行超时（可配置分钟数）→ STALE
4. **同实例优先**: 内存中进程对象存活 → 仍为 RUNNING
5. **跨实例后备**: PID 存活检测（Flask/Express 重启后进程对象丢失）
6. **exit_code short-circuit**: exit_code !== 0 → 直接 CRASHED（不能 fallthrough 到其他启发式）
7. **auto-commit**: 进程退出但 worktree 有未提交变更 → 自动 commit 后标 DONE
8. **transition callback**: 状态从 RUNNING 转为终态时触发回调，驱动 DAG 依赖解析

**不变量**: 检测优先级顺序是设计不变量（终态→STALE→同实例→跨实例→exit_code→fallback），具体检测手段因平台/语言而异。

→ 详见 [state-machine.md](state-machine.md)

---

## 5. 风险分级审查 — 人只看 HIGH

**设计约束**:

1. **评估必须在 merge 之前**: `assess_risk()` 必须在 `_merge_agent()` 之前调用（merge 后 diff 为空）
2. **diff 范围**: `git diff <base_branch>...HEAD`（捕获已提交的改动）
3. **6 个风险信号**: 每个信号独立判定 LOW/HIGH
4. **整体规则**: 任一 HIGH → 整体 HIGH
5. **3 种 merge 策略**: auto（LOW 自动 merge / HIGH 进 REVIEW）、always（全部 REVIEW）、never（全部 ACCEPTED）
6. **冲突检测**: 试合并 + 回滚，不改变工作区
7. **PR 创建**: REVIEW 时自动创建 PR，失败不阻塞

### 6 个风险信号（设计不变量）

| 信号 | 判定语义 | HIGH 条件 |
|------|---------|-----------|
| file_count | 改动涉及多少文件 | > max_files (默认5) |
| line_count | 改动涉及多少行 | > max_lines (默认200) |
| new_files | 是否创建了新文件 | 有新文件 |
| public_modules | 是否改动了共享模块（core/lib/src 路径段） | 改动了公共模块 |
| conflict | merge 是否有冲突 | 有冲突 |
| test | 改动是否包含测试 | 有改动但无测试文件 |

**实现自由**: 具体的 git 命令、diff 解析方式、公共模块路径段的匹配逻辑。

→ 详见 [risk-assessment.md](risk-assessment.md)

---

## 6. done() 流程 — 风险门禁核心

**设计约束**（顺序是不变量）:

```
StatusDetector 检测到 agent 退出(exit_code=0)
  → transition callback 自动触发 done(name)
    │
    ├── 1. assess_risk() — 必须 merge 前！
    ├── 2. 持久化风险结果
    ├── 3. merge agent 分支到主分支
    │     - merge 前自动 commit（agent 可能不 commit）
    │     - **变更检测用 `git status --porcelain`**（不用 `git diff --cached --quiet`，agent 可能已自行 commit）
    │     - **merge 在主仓库目录执行**（不在 worktree 中，worktree 的 master ≠ 主仓库的 master）
    │     - merge 冲突 → 尝试自动解决（见 §6.1）
    │     - 自动解决成功 → 继续流程
    │     - 自动解决失败 → CONFLICTED（保留 worktree，等人处理）
    ├── 4. 停止 agent 进程
    ├── 5. 分级决策:
    │     - merge_strategy="auto" + LOW → ACCEPTED + 清理 worktree（无人干预）
    │     - merge_strategy="auto" + HIGH → REVIEW + 创建 PR + 保留 worktree
    │     - merge_strategy="always" → REVIEW + 创建 PR
    │     - merge_strategy="never" → ACCEPTED
    └── 6. 触发 DAG 依赖解析（立即解锁下游任务）
```

**不变量**: done() 由 transition callback 自动触发，不需要人工干预。人只在 REVIEW（HIGH 风险）和 CONFLICTED（自动解决失败的 merge 冲突）时介入。

### §6.1 Merge 冲突自动解决

**设计约束**:

merge 冲突时，先尝试自动解决，失败才抛给人。自动解决策略按文件类型分：

| 文件类型 | 冲突模式 | 自动解决策略 |
|---------|---------|-------------|
| `package.json` | add/add（各自加依赖） | 合并两边的 dependencies/devDependencies，取并集 |
| `src/*.ts` 源码 | add/add（各自加类/函数） | 识别 import 区 + export 区 + 类定义，按顺序拼接（ours 前 theirs 后） |
| `*config*` 配置文件 | add/add | 深合并（deep merge），ours 为基准叠 theirs 新增 key |
| 其他 | 任何 | 不自动解决，CONFLICTED 留人 |

**自动解决流程**（不变量）:

```
git merge → 冲突
  → 按文件类型分派自动解决策略
  → 逐文件尝试解决
  → 解决后 git add + 验证（tsc --noEmit / biome check / vitest run）
  → 验证通过 → 自动 commit → 继续流程
  → 验证失败或无法解决 → git merge --abort → CONFLICTED
```

**安全边界**（不变量）:

1. 自动解决后必须验证（至少 `tsc --noEmit`），验证失败则回退
2. 无法识别冲突结构的文件不自动解决
3. 自动解决日志写入状态存储，供人审计
4. 并发 merge 时串行化（同一时刻只有一个 agent 在 merge）

**实现自由**: 具体的 AST 解析方式（ts-morph / 正则 / 行分析）、验证命令组合、回退策略。

**accept/reject 约束**:
- accept: REVIEW→ACCEPTED + 清理 worktree
- reject: REVIEW→REJECTED + 清理 worktree
- 已知缺陷: reject 未回滚已合并的改动

**worktree 清理规则**（不变量）:
- ACCEPTED → 清理
- REJECTED → 清理
- CONFLICTED → 保留（供手动解决冲突）
- REVIEW → 保留（供 PR 引用）

→ 详见 [risk-assessment.md](risk-assessment.md)

---

## 7. DAG 调度 — PRD 驱动并行

**设计约束**:

1. **两种输入格式**: plan.md (YAML frontmatter) 和 prd.json
2. **DAG 验证 4 规则**: ID 合法、无重复、无缺引用、无环
3. **maxConcurrent 限制**: 同时运行的 agent 数量上限
4. **依赖解析**: dep REJECTED → 级联 REJECTED；dep DONE/ACCEPTED → 依赖满足
5. **root 任务**: depends_on=[] 的任务在计划启动时执行
6. **计划启动前**: 检查无活跃计划 + worktree 全部预创建（启动零延迟）
7. **prompt 完整性**: fromPrdJson() 生成的 prompt 必须包含 acceptanceCriteria 全部条目 + "不要提问，直接实现"指令
8. **依赖任务 rebase**: start() 创建 worktree 后必须 rebase 到最新 baseBranch，获取上游已完成任务的代码

**prd.json 格式约束**（looomer 自身消费）:
```json
{
  "project": "name",
  "userStories": [{"id": "US-001", "description": "..."}],
  "taskSplit": [{"id": "TS-001", "userStory": "US-001", "depends": []}]
}
```

**实现自由**: YAML 解析用 js-yaml / 手写 / 其他；环检测用 Kahn / DFS / 其他。

→ 详见 [dag-scheduling.md](dag-scheduling.md)

---

## 8. Web + SSE — 实时仪表盘

**设计约束**:

1. **SSE 只推变化**: 不每个轮询周期都发全量，只发状态变化的 agent
2. **心跳**: 定期发送 SSE 注释保持连接
3. **错误格式统一**: `{error: "ClassName", message: "描述"}`，HTTP 400
4. **归档过滤**: status 端点默认不含已归档 agent，`?archived=true` 含归档
5. **DAG SVG 可视化**: DAG 面板必须用 SVG 拓扑分层 + 有向边 + 颜色编码，不能用 flex-wrap div
6. **进度条**: Plan 面板必须显示进度条（动画）和完成百分比
7. **操作按钮完整**: DONE→Merge, CRASHED/STALE→Retry, REVIEW→Accept/Reject, 非活跃→Delete
8. **统计色点**: Plan 统计必须用色点 + 标签展示，不能只有文本
9. **端口冲突降级**: startServer() 必须捕获 EADDRINUSE，降级运行不崩溃

**实现自由**: Express / Fastify / Koa；EJS / Pug / 纯静态 HTML；轮询间隔；心跳间隔。

→ 详见 [web-and-sse.md](web-and-sse.md)

---

## 9. Archive — 活跃/归档分离

**设计约束**:

1. agent 数据新增 `archived: boolean` 字段
2. 默认列表只显示活跃 agent（archived=false）
3. `--all` / `?archived=true` 含归档
4. 归档不删除数据，只是从默认视图中隐藏

**实现自由**: 归档字段存 SQLite / JSON / 其他。

---

## 10. 常驻主进程 — LoomerApp 管控 Web 附属

**设计约束**:

1. **plan run 即启动主进程**: `loomer plan run --prd` 启动 LoomerApp 主进程 + Web 仪表盘
2. **Web 是附属组件**: LoomerApp 持有 Web，可独立启停（`startServer()`/`stopServer()`），Web 不绑架主进程生命周期
3. **Web 自动关闭**: 全终态且无 REVIEW/CONFLICTED → 自动 `stopServer()` 释放端口；有 REVIEW/CONFLICTED 则保留
4. **Web 手动管控**: CLI `loomer web-start [--port]`/`loomer web-stop` + API `POST /api/web/start|stop`
5. **CLI HTTP 薄客户端**: 其余子命令（done/kill/retry/accept/reject/log/status）通过 HTTP 发给运行中的主进程；主进程未运行时 status/log 可直读 SQLite（只读）
6. **SIGINT/SIGTERM 优雅关闭**: 捕获信号 → 停止轮询 → 停止 Web → 杀子进程 → 退出
7. **LoomerApp.create() 工厂方法**: CLI 入口必须通过 `LoomerApp.create(config)` 工厂方法创建实例（内部构建依赖），构造函数保留给测试（依赖注入）
8. **全局 shutdown**: CLI `loomer shutdown` + API `POST /api/shutdown` → 优雅关闭整个 LoomerApp

**取消 daemon**: LoomerApp 作为常驻主进程运行，不需要 launchd/systemd 后台服务。用户通过 `loomer plan run` 启动，按 Ctrl+C 或等待计划完成后自动退出。

→ 详见 [api-spec.md §10](api-spec.md)

## 11. Dogfooding 教训 — 必须内化

以下是从 dogfooding 中发现的设计缺陷，loomer 必须避免：

| # | 教训 | 设计约束 |
|---|------|---------|
| 1 | 缺 --verbose 导致 stream-json 无法解析 | 启动参数中 `--output-format stream-json --verbose --include-partial-messages` 三件套不可省略 |
| 2 | 跨进程状态丢失 | 状态存储必须支持跨进程访问；PID 检测必须在内存检测之后 |
| 3 | TS 编号跨计划冲突 | 建议项目缩写前缀（不强制） |
| 4 | _plan_executor 重启为 null | `planStatus()` 必须有从存储重建的兜底路径 |
| 5 | worktree 不清理导致膨胀 | 终态后必须清理 worktree（CONFLICTED/REVIEW 除外） |
| 6 | exit_code 误判 | exit_code !== 0 必须直接 CRASHED，不 fallthrough |
| 7 | agent 不 commit 导致 merge 空 diff | merge 前必须 `git add -A + auto-commit` |
| 8 | 旧计划残留阻塞新计划 | `runPlan()` 启动前必须清理旧数据 |
| 9 | CWD 变化导致 git 命令错目录 | 所有 git 命令必须显式指定 cwd=绝对路径 |
| 10 | 旧数据缺字段 crash | 状态读取必须防御性处理缺失字段 |
| 11 | 仪表盘不展示风险信息导致盲操作 | REVIEW 状态必须展示 risk_assessment（6 信号详情），让人知道为什么进 REVIEW |
| 12 | 并行 agent 修改共享文件导致 merge 冲突 | 冲突先自动解决（§6.1），失败才抛人；串行化并发 merge |
| 13 | WorkspaceManager 不幂等导致重复运行崩溃 | create() 必须幂等（worktree/分支/目录残留均容忍） |
| 14 | 子进程 PATH 缺 bun 导致 agent 无法启动 | ProcessManager.start() 必须构建增强 PATH |
| 15 | 端口占用导致进程崩溃 | startServer() 必须捕获 EADDRINUSE，降级运行 |
| 16 | _mergeAgent 在 worktree 中 merge 但代码丢失 | merge 必须在主仓库目录执行，不在 worktree 中 |
| 17 | git diff --cached 判断"无变更"不可靠 | 必须用 git status --porcelain 判断 |
| 18 | 非交互模式 agent prompt 缺 acceptance criteria | prompt 必须包含 criteria + "不要提问"指令 |
| 19 | 依赖任务 worktree 缺少上游合并代码 | start() 必须 rebase 到最新 baseBranch |
| 20 | Web DAG 不可视化（无 SVG 拓扑） | DAG 必须用 SVG 拓扑分层 + 有向边渲染 |
| 21 | Plan 进度无进度条 | 必须显示进度条 + 百分比 |
| 22 | Agent 操作按钮不全 | DONE→Merge, CRASHED/STALE→Retry, 非活跃→Delete |
| 23 | Plan 统计无可视化色点 | 统计必须有色点 + 标签 |
| 24 | LoomerApp 缺少 CLI 友好工厂方法 | 必须提供 create() 静态工厂，构造函数保留给测试 |

→ 详见 [technical-decisions.md §8](technical-decisions.md)

---

## 设计文档索引

| 文档 | 性质 | 何时查阅 |
|------|------|---------|
| [design-spec.md](design-spec.md)（本文件） | 设计主线 + 不变量 | 开始实现前通读，每个模块实现时回顾对应章节 |
| [api-spec.md](api-spec.md) | TypeScript 接口签名 | 编写具体模块时对照签名 |
| [state-machine.md](state-machine.md) | 9 状态 + 转换规则 + 检测优先级 | 实现 StatusDetector 时 |
| [risk-assessment.md](risk-assessment.md) | 6 信号 + done() 流程 + merge 策略 | 实现 SafetyChecks + LoomerApp.done() 时 |
| [dag-scheduling.md](dag-scheduling.md) | prd.json 格式 + DAG 验证 + 依赖解析 | 实现 PlanParser + PlanExecutor 时 |
| [technical-decisions.md](technical-decisions.md) | 7 个技术决策 + 22 条 dogfooding 教训 | 遇到技术选型问题时 |
| [web-and-sse.md](web-and-sse.md) | REST API + SSE + 仪表盘 | 实现 Web 层时 |
| [local-dev-workflow.md](local-dev-workflow.md) | 安装、调试迭代、命令速查 | 本地开发调试时 |
