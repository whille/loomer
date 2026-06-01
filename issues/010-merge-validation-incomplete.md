# ISS-010: 自动合并验证只跑 tsc，缺少 biome 和 vitest

## 严重级别

MEDIUM

## 位置

- `src/app.ts:531` — 验证只执行 `npx tsc --noEmit`

## 描述

设计规范（`doc/design-spec.md` 约束 6.1）规定自动合并验证应执行 `tsc --noEmit / biome check / vitest run` 三项。实际实现只跑 `tsc --noEmit`。

后果：自动解决的冲突可能通过类型检查，但存在 lint 违规或测试失败。

## 修复方案

在 `tsc --noEmit` 后追加两项验证：

```ts
const validators = [
  { cmd: "npx", args: ["tsc", "--noEmit"], label: "TypeScript" },
  { cmd: "npx", args: ["biome", "check", "src/"], label: "Biome" },
  { cmd: "npx", args: ["vitest", "run"], label: "Vitest" },
];
```

任一失败 → 标记 CONFLICTED，不自动合并。
