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

**Python 实现参考**（仅供参考，loomer 不必照搬）:
- JSON 文件 + fcntl.flock + threading.Lock + atomic rename
- 目录: `sha256(repo_path)[:12]` 子目录

**Node.js 可选方案**: SQLite WAL / JSON+file-lock / levelDB / 其他

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
6. **PATH 兼容**: 确保 claude CLI 的运行时在 PATH 中

**Python 实现参考**:
- subprocess.Popen + worker.log 文件 + 监控线程
- stdin=DEVNULL（避免 /proc 暴露 prompt）

**Node.js 可选方案**: child_process.spawn + stdout pipe 实时消费 / 其他

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

**Python 实现参考**:
- os.kill(pid, 0) 做 PID 检测
- worker.log 文件内容做启发式 fallback

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
1. assess_risk() — 必须 merge 前！
2. 持久化风险结果
3. merge agent 分支到主分支
   - merge 前自动 commit（agent 可能不 commit）
   - merge 冲突 → CONFLICTED（保留 worktree）
4. 停止 agent 进程
5. 分级决策:
   - merge_strategy="auto" + LOW → ACCEPTED + 清理 worktree
   - merge_strategy="auto" + HIGH → REVIEW + 创建 PR + 保留 worktree
   - merge_strategy="always" → REVIEW + 创建 PR
   - merge_strategy="never" → ACCEPTED
6. 触发 DAG 依赖解析
```

**accept/reject 约束**:
- accept: REVIEW→ACCEPTED + 清理 worktree
- reject: REVIEW→REJECTED + 清理 worktree
- ⚠️ 已知缺陷: reject 未回滚已合并的改动

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

## 10. Daemon — 后台服务

**设计约束**:

1. **平台自动检测**: macOS → launchd, Linux → systemd, 其他 → 报错
2. **抽象后端**: 统一 install/uninstall/start/stop/status 接口，平台实现可插拔
3. **服务命令**: `{node} src/cli.js serve`（或等效入口）
4. **元数据持久化**: PID + 启动时间写入文件，用于 status 检测
5. **日志轮转**: 按大小切割 + gzip 压缩 + 数量上限，防止磁盘溢出
6. **失败容错**: stop/uninstall 时服务已停不报错

**实现自由**: plist/unit 文件模板；日志路径；轮转大小/数量阈值。

→ 详见 [api-spec.md §12](api-spec.md)

---

## 11. Dogfooding 教训 — 必须内化

以下是从 conductor-ui 实际 dogfooding 中发现的缺陷，loomer 必须避免：

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

→ 详见 [technical-decisions.md §8](technical-decisions.md)

---

## 设计文档索引

| 文档 | 性质 | 何时查阅 |
|------|------|---------|
| [design-spec.md](design-spec.md)（本文件） | 设计主线 + 不变量 | 开始实现前通读，每个模块实现时回顾对应章节 |
| [api-spec.md](api-spec.md) | TypeScript 接口签名 | 编写具体模块时对照签名 |
| [state-machine.md](state-machine.md) | 9 状态 + 转换规则 + 检测优先级 | 实现 StatusDetector 时 |
| [risk-assessment.md](risk-assessment.md) | 6 信号 + done() 流程 + merge 策略 | 实现 SafetyChecks + ConductorApp.done() 时 |
| [dag-scheduling.md](dag-scheduling.md) | prd.json 格式 + DAG 验证 + 依赖解析 | 实现 PlanParser + PlanExecutor 时 |
| [technical-decisions.md](technical-decisions.md) | 7 个技术决策对比 + 10 条 dogfooding 教训 | 遇到"Python 这样做，Node.js 怎么做"时 |
| [web-and-sse.md](web-and-sse.md) | REST API + SSE + 仪表盘 | 实现 Web 层时 |
