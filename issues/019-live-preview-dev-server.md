# ISS-019: Live Preview（Dev Server 集成）

## 严重级别

LOW

## 来源

Conductor 技术分析 §4.1.3

## 位置

- `src/workspace.ts` — WorkspaceManager 无 dev server 管理
- `src/process.ts` — ProcessManager 未管理 dev server 进程

## 描述

Conductor 每个 workspace 运行独立 dev server + 文件监听，实时预览变更。这对前端项目尤其有价值 — 可以立即看到 agent 的 UI 改动效果。

Loomer 目前无 dev server 集成，agent 的前端改动只能通过代码 diff 或手动启动 dev server 查看。

## 实现思路

1. WorkspaceManager 创建 worktree 时，可选启动 dev server（配置中声明 `devCommand: "npm run dev"`）
2. ProcessManager 管理 dev server 进程生命周期
3. Web dashboard 通过 iframe / proxy 展示预览（`/preview/<agent-name>`）
4. workspace 销毁时自动停止 dev server
5. 多 workspace 的 dev server 需端口分配策略（避免冲突）

## 参考

- Conductor: Vite 5173 端口，文件监听 + 实时预览
