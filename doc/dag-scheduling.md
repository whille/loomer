# Loomer PRD 驱动 DAG 调度

> 来源：conductor-ui `conductor/core/plan.py` (450 行) + `conductor/core/app.py` run_plan()

## 流水线概览

```
PRD → /prd skill → prd.json → loomer plan run --prd prd.json → DAG 验证 → 并行调度 → 风险审查 → merge/PR
```

## prd.json 格式规范

```json
{
  "project": "feature-name",
  "branchName": "feature-kebab-case",
  "description": "功能描述",
  "userStories": [
    {
      "id": "US-001",
      "title": "用户故事标题",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": ["可验证条件1", "可验证条件2"],
      "depends": [],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ],
  "taskSplit": [
    {
      "id": "TS-001",
      "title": "任务标题（对应 US-001）",
      "userStory": "US-001",
      "depends": [],
      "parallel": true,
      "branch": "feat/short-name"
    }
  ]
}
```

### 字段说明

| 字段 | 用途 |
|------|------|
| `project` | → plan name |
| `taskSplit[].id` | → agent name（task ID 即 worktree 分支名） |
| `taskSplit[].userStory` | → 引用 userStories 中的 description 作为 prompt |
| `taskSplit[].depends` | → dependsOn（前向依赖列表） |
| `taskSplit[].parallel` | → 信息字段，依赖全满足后自动并行 |
| `taskSplit[].branch` | → 信息字段，实际使用 id 作为分支名 |

### depends 推导

TS-001 的 `depends: ["TS-002"]` → 找到 TS-002 对应的 US-002 → 该 US 的 `depends: ["US-002"]`

## PlanParser

### parse(path) — 从 plan.md 解析

- 提取 YAML frontmatter（`---` 之间）
- 解析 YAML 子集 → PlanSpec
- Python 手写 YAML 子集解析器 → Loomer 用 `js-yaml` 包替代

### fromPrdJson(path, maxConcurrent) — 从 prd.json 解析

```typescript
static fromPrdJson(path: string, maxConcurrent: number = 5): PlanSpec
```

1. 读取 prd.json
2. `project` → `planSpec.name`
3. `taskSplit` → `TaskSpec[]`：
   - `id` → `taskSpec.id`
   - prompt 优先用 `userStory` 引用的 `description`，回退到 `title`
   - `depends` → `taskSpec.dependsOn`
4. `maxConcurrent` 来自参数或 prd.json

## DAGValidator 规则

### 1. 任务 ID 合法性
- 正则：`^[a-zA-Z0-9_-]+$`
- 长度 ≤ 64

### 2. 无重复 ID
- 同一 plan 内 task ID 唯一

### 3. 无缺失引用
- `dependsOn` 中引用的 ID 必须存在

### 4. 无环（Kahn 算法拓扑排序）
```
in_degree = { task: len(task.dependsOn) for task in tasks }
queue = [task for task, deg in in_degree if deg === 0]
sorted_count = 0

while queue:
  node = queue.shift()
  sorted_count++
  for dependent in dependents[node]:
    in_degree[dependent]--
    if in_degree[dependent] === 0:
      queue.push(dependent)

if sorted_count < len(tasks):
  throw DAGValidationError("dependency graph contains a cycle")
```

## PlanExecutor 调度

### registerTasks()
- 所有任务注册到 state：status=PENDING，prompt、dependsOn、plan 写入
- root 任务（dependsOn=[]）也先标 PENDING，由 run 决定何时启动

### runPlan() 流程

1. 检查已有活跃计划 → PlanAlreadyActiveError
2. 解析 prd.json → PlanSpec
3. DAGValidator.validate(spec)
4. spec.maxConcurrent 覆盖 config.maxConcurrent
5. executor.registerTasks()
6. 为所有任务创建 worktree（确保 PENDING 启动零延迟）
7. state.setPlan({ name, maxConcurrent, tasks })
8. 启动 root 任务（dependsOn=[]），尊重 maxConcurrent
9. 保存 executor 引用 → _planExecutor

### onTaskDone(taskId) — 依赖解析

某任务完成时触发（transition callback）：

1. 遍历所有 PENDING 任务
2. 检查依赖状态：
   - REJECTED → 级联 REJECTED（子任务也拒绝）
   - DONE / ACCEPTED → 依赖满足
   - 其他 → 依赖未满足，跳过
3. 依赖全满足 + runningCount < maxConcurrent → `_startPending(taskId)`
4. 返回新启动的 task IDs

### 级联拒绝

```typescript
for (const task of spec.tasks) {
  if (state.getAgent(task.id).status !== 'PENDING') continue
  for (const dep of task.dependsOn) {
    if (state.getAgent(dep).status === 'REJECTED') {
      state.updateAgentStatus(task.id, 'REJECTED')
      // 继续检查其他 PENDING（不 break，让级联传播）
      break
    }
  }
}
```

### isPlanComplete()

所有任务达到终态（DONE / ACCEPTED / REJECTED / CRASHED / CONFLICTED / STALE）。

### getProgress()

```typescript
{
  total: number
  done: number      // DONE + ACCEPTED
  running: number
  pending: number
  crashed: number
  conflicted: number
  stale: number     // Loomer 新增
  review: number    // Loomer 新增（含 REVIEW + REJECTED）
}
```

conductor-ui Python 原版只统计 done/running/pending/crashed/conflicted，Loomer 增加 stale/review 覆盖所有状态。

## transition callback 触发链

```
StatusDetector 检测到 RUNNING→终态
  → _fire_transition(name, newStatus)
    → ConductorApp._trigger_dep_resolution(name)
      → state.getPlan() 检查是否有活跃计划
        → PlanExecutor.onTaskDone(name)
          → 检查 PENDING 任务依赖
            → _start_pending(taskId)
```

## planStatus / planDag API

### planStatus()
- 有 _planExecutor → executor.getProgress()
- 无（Web 服务重启后）→ _countPlanProgress(plan) 从存储重新统计

### planDag()
- 返回 DAG 结构供前端可视化
- nodes: `[{ id, status }]`
- edges: `[{ from: dep, to: taskId }]`

## Web API

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | /api/plan/run | `{ path: string }` 或 `{ prdPath: string }` → 执行计划 |
| GET | /api/plan/status | 计划进度 `{ plan, total, done, running, ... }` |
| GET | /api/plan/dag | DAG 结构 `{ nodes, edges }` |

## Dogfooding 教训

**_planExecutor 重启兜底：** Express 重启后 _planExecutor 为 null，planStatus() 必须有 `_countPlanProgress()` 从 SQLite 重新统计进度的兜底路径。不能假设 executor 对象始终可用。

**TS 编号用项目前缀：** 多计划共存时 TS-001 等通用编号会冲突。建议 prd.json 中 `taskSplit[].id` 使用项目缩写前缀（如 LMR-001），避免跨计划 ID 冲突。PlanExecutor 不强制，但 /prd skill 推荐此惯例。
