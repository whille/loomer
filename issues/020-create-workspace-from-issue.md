# ISS-020: 从 Issue 一键创建 Workspace

## 严重级别

LOW

## 来源

Conductor 技术分析 §4.2.1

## 位置

- `src/cli.ts` — CLI 无 `--from-issue` 选项
- `src/plan.ts` — PlanParser 只解析 prd.json / plan.md

## 描述

Conductor 支持从 GitHub Issue / Linear Issue 一键创建 workspace，自动提取 issue 描述作为 task 上下文。Loomer 当前只能通过 prd.json 或手动 `loomer start` 启动 agent。

从 Issue 创建 workspace 能减少手动写 prompt 的步骤，适合"一个 issue = 一个 agent"的轻量场景。

## 实现思路

1. CLI 增加 `loomer start --from-issue <url>` 命令
2. 解析 GitHub Issue URL → `gh issue view <number> --json title,body`
3. 解析 Linear Issue URL → Linear API
4. 自动生成 TaskSpec（title → name, body → prompt）
5. 创建 worktree + 启动 agent
