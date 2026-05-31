# Loomer Web 层 + SSE 设计

## 设计约束

1. **SSE 只推变化**: 不每个轮询周期发全量，只发状态变化的 agent
2. **心跳**: 定期发 SSE 注释保持连接（防止代理/负载均衡器超时断开）
3. **错误格式统一**: `{error: "ClassName", message: "描述"}`，HTTP 400
4. **归档过滤**: status 端点默认不含已归档 agent，`?archived=true` 含归档
5. **单页面仪表盘**: 纯 HTML + vanilla JS，无前端框架
6. **SSE 自动重连**: 浏览器 EventSource 原生重连，前端需处理重连后状态同步
7. **diff 端点耦合**: `/api/diff/:name` 直接访问 statusDetector（已知耦合点，loomer 可选择封装到 app 层）

## REST API

| 方法 | 路径 | 功能 | 请求体/参数 |
|------|------|------|------------|
| GET | / | 仪表盘（dashboard） | - |
| GET | /api/status | 所有 agent 状态 | `?archived=false` |
| POST | /api/start | 创建 agent | `{ name, prompt }` |
| GET | /api/log/:name | agent 日志 | `?lines=50` |
| GET | /api/diff/:name | git diff | `?mode=stat` |
| POST | /api/done/:name | 风险分级 merge | - |
| POST | /api/kill/:name | 强制终止 | `?clean=0` |
| POST | /api/retry/:name | 重试 | - |
| POST | /api/accept/:name | 审查通过 | - |
| POST | /api/reject/:name | 审查拒绝 | - |
| GET | /api/events | SSE 实时推送 | - |
| POST | /api/plan/run | PRD DAG 执行 | `{ path }` 或 `{ prdPath }` |
| GET | /api/plan/status | 计划进度 | - |
| GET | /api/plan/dag | DAG 结构 | - |

## SSE 协议

### 格式

```
event: status
data: {"agent-name": "RUNNING", "other-agent": "DONE"}

: keepalive

```

### 设计约束

- 轮询间隔、心跳间隔为**实现自由**
- 变更检测：对比前后两次 status 结果，只推变化部分
- 心跳：SSE 注释 `: keepalive\n\n`

### Node.js 参考实现

```typescript
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const lastStatus: Record<string, string> = {}

  const interval = setInterval(() => {
    const agents = app.status()
    const current: Record<string, string> = {}
    for (const a of agents) current[a.name] = a.status

    // 只推送变化
    const changed: Record<string, string> = {}
    for (const [k, v] of Object.entries(current)) {
      if (lastStatus[k] !== v) changed[k] = v
    }
    Object.assign(lastStatus, current)

    if (Object.keys(changed).length > 0) {
      res.write(`event: status\ndata: ${JSON.stringify(changed)}\n\n`)
    }
  }, POLL_INTERVAL_MS)

  req.on('close', () => clearInterval(interval))
})
```

## EJS 模板结构

```
views/
  layout.ejs      — 基础布局（导航 + 内容区）
  index.ejs       — 单页面仪表盘
```

### 仪表盘内容

- Agent 列表：名称、状态徽章、分支、prompt 摘要、操作按钮
- 操作按钮按状态显示：RUNNING→Kill, DONE→Merge, CRASHED→Retry, REVIEW→Accept/Reject
- 日志查看 / Diff 查看（弹出层）
- DAG SVG 可视化（计划执行时）
- SSE 客户端：EventSource('/api/events')，自动重连

## 错误处理

```typescript
app.use((err, req, res, next) => {
  if (err instanceof LoomerError) {
    res.status(400).json({ error: err.constructor.name, message: err.message })
  } else {
    res.status(500).json({ error: 'InternalError', message: err.message })
  }
})
```

## Dogfooding 教训

| # | 教训 | Web 层影响 |
|---|------|-----------|
| 1 | stream-json --verbose | 前端日志显示依赖正确解析，缺少参数会导致日志为空 |
| 4 | _plan_executor 为 null | planStatus() 必须有从存储重建的兜底路径，Web 重启后尤甚 |
| 9 | CWD 问题 | Express 可能以不同 CWD 启动，git 命令必须用绝对路径 |
| 10 | 缺字段防御 | status API 返回的 agent 数据可能缺字段，前端 JS 必须容错 |
| 13 | DAG 必须用 SVG 拓扑可视化 | flex-wrap div 不可接受，必须 BFS 拓扑分层 + 贝塞尔曲线有向边 + 箭头 + 颜色编码 + 点击高亮 |
| 14 | Plan 进度必须有进度条 | 纯文本不可接受，必须 DOM 进度条 + 百分比 + CSS 动画 |
| 15 | Agent 操作按钮必须完整 | DONE→Merge, CRASHED/STALE→Retry, 非活跃→Delete(clean=1)，后端路由已存在 |
| 16 | Plan 统计必须有可视化色点 | 纯文本不可接受，必须色点 + 标签 |
| 17 | 端口冲突不能崩溃 | startServer() EADDRINUSE 必须降级运行（不启动 dashboard 但不退出） |
