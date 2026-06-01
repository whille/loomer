# ISS-009: skillPrefix 配置了但未实现

## 严重级别

MEDIUM

## 位置

- `src/config.ts:25,39,96,112` — `skillPrefix` 字段声明
- `src/process.ts:74-87` — `ProcessManager.start()` 未引用 skillPrefix

## 描述

设计规范（`doc/design-spec.md` 约束 3 项 2）描述："skill 前缀（TDD/review/系统调试规则）可配置开关"。config 中有 `skillPrefix` 布尔字段，但 `ProcessManager.start()` 构建 agent prompt 时从未使用此字段。

## 修复方案

选项 A：实现 — 当 `skillPrefix === true` 时，在 agent prompt 前追加 TDD / review / 系统调试规则前缀

选项 B：移除 — 删除 config 中的 `skillPrefix` 字段，避免死代码

建议先移除，有明确需求时再实现。
