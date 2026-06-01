# ISS-008: autoMergeRules.conflict / testFail 是死代码

## 严重级别

MEDIUM

## 位置

- `src/config.ts:13-14` — `conflict` 和 `testFail` 字段声明
- `src/safety.ts:203` — 冲突信号硬编码 HIGH，不读取 rules.conflict

## 描述

`LoomerConfig.autoMergeRules` 声明了 `conflict: "review" | "auto"` 和 `testFail: "review" | "auto"` 两个配置项，但 `SafetyChecks.assessRisk()` 从未读取这两个字段。

实际行为：
- `conflict` 信号：硬编码为 HIGH，即使配置 `conflict: "auto"` 也无法自动合并冲突
- `testFail` 信号：完全未实现，无任何风险信号生成逻辑

用户配置了这些选项但不会生效，造成误解。

## 修复方案

1. 在 `SafetyChecks.assessRisk()` 中读取 `rules.conflict`，当值为 `"auto"` 时将冲突信号降级为 LOW
2. 实现 testFail 信号检测（检查 agent 输出中的测试失败模式）
3. 或移除这两个死代码字段，避免用户误用

## 参考

- `src/config.ts` 的 ConfigSchema 声明
- README 描述了 6 个风险信号，但 conflict 的 auto 配置未实现
