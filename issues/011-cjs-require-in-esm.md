# ISS-011: ESM 模块中使用 CJS require()

## 严重级别

MEDIUM

## 位置

- `src/app.ts:515` — `const { writeFileSync } = require("node:fs")`

## 描述

`package.json` 声明 `"type": "module"`（ESM），但 `app.ts:515` 使用 `require()` 导入 `writeFileSync`。这在 bun 下可运行（bun 兼容 CJS/ESM），但在 strict Node.js ESM 模式下会报错。

此外，`fs` 模块已在文件顶部通过 `import * as fs from "node:fs"` 导入，`writeFileSync` 可直接用 `fs.writeFileSync`。

## 修复方案

删除 `app.ts:515` 的 `require()` 行，改用顶部已导入的 `fs.writeFileSync`。

工作量：极低（1 行改动）。
