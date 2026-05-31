# Loomer 风险分级审查门禁

> 来源：conductor-ui `conductor/core/safety.py` (270 行) + `conductor/core/app.py` done() (478 行)

## 设计原则

**人只看 HIGH** — 低风险改动自动 merge，高风险进 REVIEW 等待人工审查。

## 6 个风险信号

| # | 信号名 | 判定规则 | HIGH 条件 | LOW 条件 |
|---|--------|---------|-----------|----------|
| 1 | file_count | git diff --name-stat 文件数 | > max_files (默认 5) | ≤ max_files |
| 2 | line_count | git diff --shortstat 总行数 | > max_lines (默认 200) | ≤ max_lines |
| 3 | new_files | git diff --name-status 中 A 开头的文件 | 有新文件 | 无新文件 |
| 4 | public_modules | 修改 core/、lib/、src/ 路径段下的文件 | 修改公共模块 | 未修改 |
| 5 | conflict | git merge --no-commit --no-ff 试合并检测 | 有冲突文件 | 无冲突 |
| 6 | test | 修改了 test_*.py / *_test.py / tests/ 目录 | 有改动但未修改测试文件 | 修改了测试文件 |

**整体规则：任一信号为 HIGH → 整体 HIGH**

## merge_strategy 三种模式

| 模式 | 行为 | 使用场景 |
|------|------|---------|
| `auto` | LOW 自动 merge → ACCEPTED，HIGH → REVIEW | 默认，平衡效率和安全 |
| `always` | 全部 HIGH → REVIEW（跳过风险评估） | 严格审查，所有改动都需人工确认 |
| `never` | 全部 LOW → ACCEPTED（跳过风险评估） | 信任 agent，自动 merge 所有改动 |

## auto_merge_rules 配置

```typescript
autoMergeRules: {
  maxFiles: 5       // 信号 1 阈值
  maxLines: 200      // 信号 2 阈值
  conflict: "review"  // 信号 5 冲突时：review=进REVIEW, auto=尝试自动解决
  testFail: "review"  // 信号 6 无测试时：review=进REVIEW, auto=忽略
}
```

## done() 完整流程

```
用户/agent 调用 done(name)
  │
  ├── 1. assess_risk() — 必须在 merge 前！否则 diff 为空
  │     ├── git diff <base_branch>...HEAD（捕获已提交改动）
  │     └── 返回 RiskAssessment { level, signals[] }
  │
  ├── 2. state.updateAgent(name, { risk_assessment })
  │
  ├── 3. _mergeAgent(name, worktree_path)
  │     ├── git add -A（worktree 中提交未暂存改动）
  │     ├── git diff --cached --quiet（检查是否有变更）
  │     ├── git commit -m "feat: {name} auto-commit"（如有变更）
  │     ├── git merge {name}（合并到主分支）
  │     └── 失败时：
  │         ├── CONFLICT → status=CONFLICTED + 保留 worktree
  │         └── 其他错误 → 抛 ConductorError
  │
  ├── 4. process.stop(name) — 终止 agent 进程
  │
  ├── 5. 分级决策
  │     ├── CONFLICTED（已在上步处理）
  │     ├── merge_strategy='never' → ACCEPTED
  │     ├── merge_strategy='always' → REVIEW + 创建 PR
  │     ├── merge_strategy='auto' + LOW → ACCEPTED + 清理 worktree
  │     └── merge_strategy='auto' + HIGH → REVIEW + 创建 PR
  │
  └── 6. _trigger_dep_resolution(name) — 通知计划执行器
```

## PR 自动创建

当 agent 进入 REVIEW 时自动创建 PR：

```typescript
_createPr(name: string, worktreePath: string): string | null
```

- 命令：`gh pr create --title <prompt[:70]> --body "## Task: {name}\n\n{prompt}" --head {name}`
- PR URL 写入 `state.agents[name].prUrl`
- 创建失败不阻塞（warning log，返回 null）

## accept / reject 流程

### accept(name)
- 前置：status === REVIEW
- 操作：`workspace.remove(name)` → status=ACCEPTED
- 触发：`_trigger_dep_resolution(name)`

### reject(name)
- 前置：status === REVIEW
- 操作：`workspace.remove(name)` → status=REJECTED
- 触发：`_trigger_dep_resolution(name)`

## Dogfooding 教训

**worktree 必须在终态后清理：** 早期实现中 worktree 在 agent 终态后未清理，`git worktree list` 越来越长。修复：done()/accept()/reject() 成功后自动 `workspace.remove()`。CONFLICTED 和 REVIEW 状态保留 worktree。

## diff 范围

**关键：** `assess_risk()` 使用 `<base_branch>...HEAD` 范围，而非 `HEAD`，确保已提交改动也能被检测。

```bash
git diff --name-status <base_branch>...HEAD
git diff --shortstat <base_branch>...HEAD
```

## 公共模块检测

修改路径段中包含 `lib`、`core`、`src` 的文件视为公共模块改动（精确匹配路径段，避免 `vendor/core/` 误匹配）：

```typescript
const parts = filepath.split("/")
if (parts.slice(0, -1).some(p => ["lib", "core", "src"].includes(p))) {
  // 公共模块
}
```

## 冲突检测

试合并 + 回滚，不改变工作区状态：

```bash
git merge --no-commit --no-ff <branch>  # 试合并
# 检查冲突...
git merge --abort                        # 回滚
```
