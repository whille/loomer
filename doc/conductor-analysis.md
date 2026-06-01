# Conductor 技术分析 & Loomer 借鉴

## 1. Conductor 概述

Conductor 是 Melty Labs 开发的 Mac 桌面应用，核心定位：**并行运行多个 AI 编码 agent（Claude Code / Codex），每个 agent 在隔离 workspace 中独立工作，完成后自动合并与创建 PR**。

- 官网：https://www.conductor.build
- 版本：0.61.0（截至 2026-06）
- 部署模型：本地 Mac 桌面应用（Conductor Cloud 为新推出的云端版本）
- 计费：不额外收费，复用用户已有的 Claude Code 登录方式（API key / Pro / Max 订阅）

---

## 2. 核心功能

### 2.1 并行 Agent 调度

- 同时运行多个 Claude Code / Codex 实例
- 每个 agent 独占一个 workspace，互不干扰
- 用户通过 UI 侧栏查看各 agent 状态

### 2.2 隔离 Workspace

- 每个 workspace = 一个 **git worktree** + 独立分支
- 包含独立的：文件、分支、聊天上下文、终端、预览、diff
- 支持从分支 / PR / GitHub Issue / Linear Issue 创建 workspace
- 快捷键 `Cmd+Shift+N` 创建新 workspace

### 2.3 工作流编排（6 步）

1. **问题分解** — 将大任务拆成可独立 review + merge 的单元
2. **Workspace 创建** — 每个可交付单元获得独立 branch + worktree
3. **Agent 执行** — agent 在 workspace 内自主编码，并行不阻塞
4. **验证 & Review** — Diff Viewer + inline comments + Review action + Checks tab
5. **PR 创建 & Merge** — 自动跟踪 GitHub Actions / status checks，条件满足后 merge
6. **归档** — 完成 workspace 归档，History pane 可恢复

### 2.4 Diff Viewer & Review

- 代码变更隔离在 workspace 中，直到 review 才合入 main
- 内联评论 → 自动转为 composer attachment → 反馈回 agent
- `Cmd+Shift+D` 打开 Diff Viewer
- Review action：agent 自主 review + 人工 review 并行

### 2.5 Checks 系统

- Git status 检查
- CI（GitHub Actions）状态跟踪
- Deployment 状态
- Comments / Todos 完成度
- 作为 merge 前的门控条件

### 2.6 Live Preview

- Workspace 内运行 dev server（如 Vite 5173 端口）
- 文件监听 + 实时预览
- Agent 可在 workspace 内执行 shell 命令（lint / test）

### 2.7 项目级引导

- Repository Settings / instruction files：项目级 agent 指导
- `.context` 文件：task-specific 上下文
- Chat + attachments：任务级上下文注入

---

## 3. 实现思路

### 3.1 架构模式

```
┌─────────────────────────────────────────────┐
│              Conductor Desktop App           │
├─────────┬──────────┬───────────┬─────────────┤
│ Sidebar  │ Workspace│ Diff      │ Checks      │
│ (agents) │ (editor) │ Viewer    │ Tab         │
├─────────┴──────────┴───────────┴─────────────┤
│              Workspace Manager                │
│  (git worktree lifecycle, branch isolation)   │
├───────────────────────────────────────────────┤
│              Agent Process Manager             │
│  (spawn Claude Code / Codex, pipe I/O)        │
├───────────────────────────────────────────────┤
│              Merge & PR Orchestrator           │
│  (conflict detection, PR creation, CI track)  │
└───────────────────────────────────────────────┘
```

### 3.2 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 隔离机制 | git worktree | 原生 Git 支持，零配置，共享 .git 目录但独立工作树 |
| Agent 通信 | stdio pipe | 复用 Claude Code CLI 的 stdin/stdout |
| 状态存储 | 本地文件系统 | 桌面应用无需中心化存储 |
| UI 渲染 | 原生桌面 | Mac 首选，低延迟交互 |
| 认证透传 | 复用 Claude Code 登录 | 零摩擦，不另建计费体系 |

### 3.3 与 Loomer 的架构对比

| 维度 | Conductor | Loomer |
|------|-----------|--------|
| 部署形态 | Mac 桌面应用 | CLI + Web Dashboard |
| 任务分解 | 人工拆分 | PRD 自动解析 + DAG 调度 |
| 并行控制 | 手动创建 workspace | DAG 依赖拓扑 + maxConcurrent |
| Agent 类型 | Claude Code / Codex | Claude Code（可扩展） |
| 合并策略 | 人工 review → merge | 风险分级（LOW auto / HIGH review） |
| 冲突处理 | agent 辅助解决 | 文件类型感知自动合并 + 验证回退 |
| 状态机 | 简单（working → review → merged） | 9 状态（PENDING → RUNNING → DONE/CRASHED/CONFLICTED/REVIEW...） |
| CI 集成 | Checks tab 跟踪 GitHub Actions | 内置验证（tsc / biome / vitest） |
| Diff Viewer | 内联评论 + agent 反馈闭环 | Web dashboard diff view |
| Live Preview | Workspace 内 dev server | 无 |

---

## 4. Loomer 可借鉴的点

### 4.1 高价值借鉴（建议实现）

#### 4.1.1 Inline Comments → Agent 反馈闭环

Conductor 的 Diff Viewer 支持 inline comments 自动转为 agent attachment，形成 review → agent fix 的闭环。Loomer 的 Web dashboard 有 diff view 但缺少这个交互。

**实现思路：**
- 在 diff view 中增加行级评论功能
- 评论数据存入 StateStore（SQLite 已有）
- 通过 ProcessManager 向 agent stdin 注入评论内容
- agent 收到评论后自主修复，状态转为 RUNNING

#### 4.1.2 Checks 系统（CI 门控）

Conductor 的 Checks tab 跟踪 git status / CI / deployment / comments / todos，作为 merge 前的门控条件。Loomer 有 SafetyChecks（风险评估）但缺少外部 CI 状态跟踪。

**实现思路：**
- 新增 `ChecksManager` 模块
- 支持 GitHub Actions API 轮询（`gh run list`）
- Checks 结果作为 merge 前置条件
- 与 RiskAssessment 合并为统一的 merge gate

#### 4.1.3 Live Preview（Dev Server 集成）

Conductor 每个 workspace 运行独立 dev server + 文件监听，实时预览变更。这对前端项目尤其有价值。

**实现思路：**
- WorkspaceManager 创建 worktree 时，可选启动 dev server
- ProcessManager 管理dev server 进程生命周期
- Web dashboard 通过 iframe / proxy 展示预览
- workspace 销毁时自动停止 dev server

### 4.2 中等价值借鉴（按需实现）

#### 4.2.1 Workspace 快捷创建

Conductor 支持从 GitHub Issue / Linear Issue 一键创建 workspace，自动提取 issue 描述作为 task 上下文。

**实现思路：**
- CLI 增加 `loomer create --from-issue <url>` 命令
- 解析 issue 标题 + body 生成 TaskSpec
- 自动创建 worktree + 启动 agent

#### 4.2.2 归档 & History

Conductor 的归档机制保持侧栏清洁，History pane 可恢复历史 workspace。

**实现思路：**
- StateStore 增加 `archived_at` 字段
- Web dashboard 侧栏过滤已归档 workspace
- History 页面展示归档 workspace 列表 + 恢复操作

#### 4.2.3 Agent 透传认证

Conductor 复用用户已有的 Claude Code 登录，零摩擦。Loomer 目前也支持，但可以更明确地文档化。

### 4.3 低价值 / 暂不需要

| 功能 | 原因 |
|------|------|
| 原生桌面 UI | Loomer 的 CLI + Web 模式更灵活，跨平台 |
| 手动 workspace 创建 | Loomer 的 DAG 自动调度更高效 |
| Conductor Cloud | Loomer 可优先本地化，云端按需 |

---

## 5. 总结

Conductor 的核心优势在于 **交互体验**（Diff Viewer 闭环、Live Preview、Checks 门控），Loomer 的核心优势在于 **自动化深度**（PRD→DAG 调度、风险分级合并、9 状态机）。

**最值得借鉴的 3 件事：**

1. **Inline Comments → Agent 反馈闭环** — 将人工 review 和 agent 修复打通，减少切换成本
2. **Checks 系统** — CI 门控让 merge 决策更可靠，与现有 SafetyChecks 互补
3. **Live Preview** — 对前端项目的 agent 工作成果提供即时可视化验证
