# ISS-023: 缺少生命周期测试 — shutdown/close/restart 无覆盖

## 严重级别

HIGH

## 位置

- `tests/app.test.ts` — 无 shutdown 测试
- `tests/state.test.ts` — 无 close() 测试
- `tests/process.test.ts` — 无 exit→last_output 持久化测试

## 描述

资源生命周期相关方法零测试覆盖：

1. **`LoomerApp.shutdown()`**（`app.ts:409-420`）— 停轮询、停 Web、杀子进程、释放 DB。无测试。
2. **`StateStore.close()`**（`state.ts:108-110`）— 释放 SQLite 连接。无测试。close() 后操作应抛错或返回 null。
3. **进程输出持久化**（`process.ts:139`）— exit 回调写 exit_code 但不写 last_output。无测试验证 last_output 是否写入（实际未写入，是 bug）。
4. **服务器重启恢复** — StateStore 数据在重启后是否可重建全部状态。无测试。

## 缺失测试

```
- shutdown() 停止轮询 + 杀子进程 + 释放资源
- close() 后 getAgent 返回 null 或抛错
- 进程退出后 StateStore.last_output 有内容（当前为空 — bug）
- 模拟重启：写入状态 → close → 重新 open → 数据完整
```
