# ISS-013: 32 个 Biome lint 错误

## 严重级别

LOW

## 位置

全项目，16 个文件

## 描述

`npx biome check src/` 报 32 个错误：

| 类别 | 数量 | 说明 |
|------|------|------|
| `noNonNullAssertion` | 5+ | `loomerApp!` 需要 null guard，不能简单 `?.` |
| `useTemplate` | 2 | 字符串拼接应改为模板字面量 |
| `noUnusedTemplateLiteral` | 3 | 不必要的反引号 |
| `useNumberNamespace` | 1 | `parseInt` → `Number.parseInt` |
| 格式化 | 12+ | 行宽、尾逗号、参数位置 |

最关键的是 5 个 `noNonNullAssertion`：`src/web.ts` 中 Express 路由访问 `loomerApp!`，如果 app 未初始化会抛 TypeError。

## 修复方案

1. `biome check --write src/` 自动修复大部分格式问题
2. `loomerApp!` 改为前置 null check + early return
