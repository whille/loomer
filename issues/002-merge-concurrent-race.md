# ISS-002: Merge 并发竞争 — _mergeAgent() 无互斥锁

## 严重级别

CRITICAL

## 位置

- `src/app.ts:424-482` — `_mergeAgent()` 无锁
- `src/app.ts:80-84` — `done()` 回调可并发触发

## 描述

设计规范（`doc/design-spec.md` 约束 6.1 项 4）明确要求："并发 merge 时串行化（同一时刻只有一个 agent 在 merge）"。但 `_mergeAgent()` 没有任何互斥机制。

DAG 并行执行时，多个 agent 几乎同时完成，它们的 `done()` 回调并发调用 `_mergeAgent()`，导致 `git merge` 操作在同一仓库中交叉执行，可能产生冲突文件损坏或合并结果不一致。

## 修复方案

在 LoomerApp 中添加异步互斥锁，使 `_mergeAgent()` 调用串行化：

```ts
private mergeQueue = new PQueue({ concurrency: 1 });

async _mergeAgent(name: string) {
  return this.mergeQueue.add(() => this._doMergeAgent(name));
}
```

或使用简单的 Promise 链互斥。

## 参考

- `doc/design-spec.md` 约束 6.1 项 4
