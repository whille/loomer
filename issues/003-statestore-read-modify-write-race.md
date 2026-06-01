# ISS-003: StateStore read-modify-write 无事务

## 严重级别

HIGH

## 位置

- `src/state.ts:121-171` — `updateAgent()` 方法

## 描述

`updateAgent()` 执行三步操作：`getAgent()`（读取）→ 合并字段 → `UPDATE/INSERT`（写入），没有 SQLite 事务包装。

当 Web API 和 status polling 并发调用 `updateAgent()` 时，两个读操作都拿到旧值，各自合并不同字段后写入，后写覆盖先写，导致丢失更新。

SQLite 的 `busy_timeout` 只序列化数据库访问，不保护应用层的 read-modify-write 原子性。

## 修复方案

用 `this.db.transaction()` 包装 read-modify-write 操作：

```ts
updateAgent(name: string, updates: Partial<AgentData>): void {
  this.db.transaction(() => {
    const existing = this.getAgent(name);
    const merged = { ...existing, ...updates };
    // ... INSERT OR REPLACE
  })();
}
```

## 参考

- better-sqlite3 原生支持 `db.transaction()` 方法
