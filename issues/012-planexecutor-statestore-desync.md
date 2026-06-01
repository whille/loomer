# ISS-012: PlanExecutor.taskStatus 与 StateStore 不同步

## 严重级别

MEDIUM

## 位置

- `src/plan.ts:213` — 内存 `taskStatus` Map
- `src/app.ts` — `done()` 回调更新 StateStore，但不一定触发 PlanExecutor 同步

## 描述

`PlanExecutor` 维护内存中的 `taskStatus` Map，与 `StateStore` 的 agent 状态是冗余的。当 `LoomerApp.done()` 更新 StateStore 后，`PlanExecutor.taskStatus` 不会自动同步。

状态转换（如 STALE、CRASHED、CONFLICTED）如果未明确触发 `onTaskXxx` 方法，内存 Map 可能过期。`getProgress()` 读取内存 Map，可能显示旧数据。

## 修复方案

选项 A：消除冗余 — `getProgress()` 直接查询 StateStore 而非内存 Map

选项 B：同步机制 — 所有状态变更统一走 PlanExecutor，由它负责写入 StateStore

建议选项 A，简化状态管理。
