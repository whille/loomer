# ISS-007: StatusDetector 自动提交崩溃 agent 代码

## 严重级别

HIGH

## 位置

- `src/status.ts:155-159` — 步骤 8 auto-commit 逻辑

## 描述

当 agent 进程终止且 worktree 有未提交变更时，StatusDetector 步骤 8 自动 `git add -A && git commit`。如果 agent 是崩溃退出，这个 auto-commit 会提交可能不完整、损坏的代码，并标记为 DONE 而非 CRASHED。

正常流程中步骤 5-6 应检测 CRASHED，但存在绕过路径：如果 ProcessManager 重建后 `hasExited` 返回 false（exit_code 未持久化），步骤 7-8 会覆盖 CRASHED 判断，自动提交后标记 DONE。

## 修复方案

1. auto-commit 前检查进程退出码：非 0 退出 → 跳过 auto-commit，标记 CRASHED
2. 持久化 exit_code 到 StateStore，避免重启后丢失
3. auto-commit 后仍检查是否有 CRASHED 信号，避免覆盖

```ts
// 步骤 8 修改
if (hasUncommittedChanges && hasExited && exitCode === 0) {
  // auto-commit
} else if (hasUncommittedChanges && hasExited && exitCode !== 0) {
  // 标记 CRASHED，不提交
}
```

## 参考

- commit `f55f3d7` 修复过孤儿进程问题，但 StatusDetector 的 auto-commit 逻辑未同步修改
