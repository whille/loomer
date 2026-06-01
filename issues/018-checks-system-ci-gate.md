# ISS-018: Checks 系统（CI 门控）

## 严重级别

MEDIUM

## 来源

Conductor 技术分析 §4.1.2

## 位置

- `src/safety.ts` — SafetyChecks 只有风险评估，无外部 CI 跟踪

## 描述

Conductor 的 Checks tab 跟踪 git status / CI（GitHub Actions）/ deployment / comments / todos，作为 merge 前的门控条件。Loomer 有 SafetyChecks（6 个风险信号）但缺少外部 CI 状态跟踪。

当前 merge 决策只看代码 diff 的静态风险，不检查 CI 是否通过。可能合入 CI 红灯的代码。

## 实现思路

1. 新增 `ChecksManager` 模块，负责收集外部检查状态
2. 支持 GitHub Actions API 轮询（`gh run list --json` 或 REST API）
3. Checks 结果作为 merge 前置条件：CI 红 → 阻止 merge 或升为 HIGH
4. 与 RiskAssessment 合并为统一的 merge gate
5. Web dashboard 新增 Checks tab 显示各检查状态

## 参考

- Conductor Checks: git status / CI / deployment / comments / todos
- 当前 SafetyChecks 可作为 Checks 的子集
