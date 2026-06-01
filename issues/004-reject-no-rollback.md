# ISS-004: reject() 不回滚已合并改动

## 严重级别

HIGH

## 位置

- `src/app.ts:201-209` — `reject()` 方法

## 描述

`reject()` 只设置状态为 REJECTED 并清理 worktree，但不调用 `git revert` 回滚已合并的 commit。语义上 REJECTED 意味着"不要这些改动"，但 commit 已经存在于主分支。

设计规范在约束 6 下承认："已知缺陷: reject 未回滚已合并的改动"。

## 修复方案

短期：在 `reject()` 中增加 `git revert` 调用，失败时降级为人工处理并记录日志。

```ts
async reject(name: string): Promise<void> {
  const agent = this.state.getAgent(name);
  if (agent.mergedCommitSha) {
    try {
      execFileSync("git", ["revert", "--no-edit", agent.mergedCommitSha]);
    } catch {
      // revert 冲突时降级，标记需人工处理
      logger.warn(`reject: git revert failed for ${name}, manual cleanup required`);
    }
  }
  // ... 原有状态更新 + worktree 清理
}
```

长期：merge 时记录 commit SHA，reject 时精确回滚。

## 参考

- `doc/design-spec.md` 约束 6 已知缺陷
- `git revert` 可能因后续 commit 冲突而失败，需要降级策略
