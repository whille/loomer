# ISS-025: _createPr 路径无测试 — 含 shell 注入风险

## 严重级别

MEDIUM

## 位置

- `src/app.ts:601-620` — `_createPr()` 方法

## 描述

`_createPr` 执行 `gh pr create` 命令创建 PR。title 中拼入了用户可控的 `prompt` 内容。如果 prompt 含 shell 元字符，可能注入命令。

当前零测试覆盖此路径，包括：
- 正常 PR 创建流程
- prompt 含元字符的安全行为
- `gh` 命令不存在时的错误处理
- PR URL 是否持久化到 StateStore

## 缺失测试

```
- 正常 PR 创建 → 返回 PR URL
- prompt 含 `; rm -rf /` → 不执行注入
- gh 不可用 → 优雅降级（不影响主流程）
```
