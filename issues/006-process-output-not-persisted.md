# ISS-006: 进程输出未持久化 — 重启后日志丢失

## 严重级别

HIGH

## 位置

- `src/process.ts:24,125,136-140` — `outputLines` 仅在内存
- `src/state.ts:21` — `AgentData.last_output` 字段已声明
- `src/cli-client.ts:174-186` — 离线回退路径读取 last_output，但永远为空

## 描述

`ProcessManager` 将 agent 输出累积在内存的 `outputLines` 数组中，但没有任何生产代码调用 `state.updateAgent(name, { last_output: ... })` 写入 SQLite。

后果：
1. 服务器重启后所有 agent 日志丢失
2. `cli-client.ts` 的离线回退路径（从 SQLite 读 last_output）永远返回空字符串
3. 无法事后审查 agent 的执行过程

## 修复方案

在 agent 输出事件或 `done()` 回调中，将输出持久化到 StateStore：

```ts
// 在 ProcessManager 的 exit 回调或 LoomerApp.done() 中
const recentOutput = this.processManager.getRecentOutput(name);
this.state.updateAgent(name, { last_output: recentOutput });
```

注意：需截断策略（如最大 50KB），避免 SQLite 存储膨胀。

## 参考

- `src/cli-client.ts:174-186` 已实现离线读取逻辑，但数据源为空
