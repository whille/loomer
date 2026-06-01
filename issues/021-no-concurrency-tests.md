# ISS-021: 缺少并发测试 — 全套测试零并发覆盖

## 严重级别

CRITICAL

## 位置

- `tests/` — 全部 15 个测试文件、356 个用例，无任何并发测试

## 描述

当前 356 个测试全部是单线程 happy path，没有任何并发测试覆盖。但 loomer 的核心场景就是多 agent 并行执行，以下并发路径完全无测试：

1. **`_mergeAgent()` 并发**（ISS-002）— 两个 agent 同时完成，同时调 `_mergeAgent()`，git merge 操作交叉
2. **`updateAgent()` 并发**（ISS-003）— Web API + status polling 并发写同一 agent，read-modify-write 丢失更新
3. **`done()` + `kill()` 并发** — 一个线程在 done() 中 merge，另一个线程 kill 同一 agent

## 缺失测试

```
- 两个并发 _mergeAgent 调用 → 不丢 commit、不交叉 git 操作
- 两个并发 updateAgent 调用 → 字段不丢失
- done() + kill() 同一 agent → 状态一致，不死锁
```

## 修复方案

1. 用 `Promise.all` 构造并发场景
2. 验证结果一致性和无异常抛出
3. ISS-002 修复合并加互斥锁后，并发测试验证锁生效
