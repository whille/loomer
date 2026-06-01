# ISS-016: package.json 缺少 lint script

## 严重级别

LOW

## 位置

- `package.json` — scripts 部分

## 描述

项目有 `check` script（`tsc --noEmit && biome check src/`）但没有 `lint` script。运行 `bun run lint` 会报错。

惯例上 `lint` 和 `check` 是不同用途：`lint` 只跑 linter，`check` 包含类型检查 + lint。

## 修复方案

```json
{
  "scripts": {
    "lint": "biome check src/",
    "check": "tsc --noEmit && biome check src/"
  }
}
```
