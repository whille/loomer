# ISS-005: StateStore 从未 close() — 资源泄漏

## 严重级别

HIGH

## 位置

- `src/app.ts:409-420` — `shutdown()` 方法
- `src/state.ts:108-110` — `close()` 方法已定义

## 描述

`StateStore` 有 `close()` 方法用于释放 better-sqlite3 连接，但 `LoomerApp.shutdown()` 调用了 `processManager.dispose()` 和 `stopServer()`，却从未调用 `this.state.close()`。

后果：WAL 锁和文件描述符泄漏，长时间运行后可能耗尽 fd。

## 修复方案

在 `shutdown()` 中 `processManager.dispose()` 之后添加一行：

```ts
this.state.close();
```

工作量：极低（1 行）。
