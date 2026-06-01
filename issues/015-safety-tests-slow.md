# ISS-015: Safety 测试过慢 — 28s 真实 git 操作

## 严重级别

LOW

## 位置

- `tests/safety.test.ts` — 每个测试创建真实 worktree / branch / merge

## 描述

Safety 测试套件耗时 28s（占整个测试套件 29s），因为每个测试都执行真实的 git 操作（worktree 创建、分支切换、合并）。

这导致 CI 反馈慢，开发者跑测试时等待时间长。

## 修复方案

1. 共享 fixture — 用 `beforeAll` 创建一次 worktree，测试间清理而非重建
2. 轻量 mock — 对 git 操作用 mock，只对 SafetyChecks 逻辑做真实测试
3. 并行化 — 将 safety 测试拆为独立文件，vitest 并行执行
