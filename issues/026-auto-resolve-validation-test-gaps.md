# ISS-026: 自动解决验证测试只覆盖 tsc，缺 biome/vitest 失败场景

## 严重级别

MEDIUM

## 位置

- `tests/merge.test.ts` — 只测了合并策略，未测验证门控
- `src/app.ts:529-548` — `_autoResolveConflicts()` 验证逻辑

## 描述

自动解决冲突后跑 `npx tsc --noEmit` 验证。设计规范要求三项验证（tsc + biome + vitest），实际只跑 tsc。

测试层面同样缺失：
- tsc 通过但 biome 失败 → 应回退（当前不会，因为没跑 biome）
- tsc 通过但 vitest 失败 → 应回退（当前不会，因为没跑 vitest）
- 验证失败后是否正确 `git merge --abort`

## 缺失测试

```
- 验证全部通过 → 自动 commit
- tsc 通过 + biome 失败 → merge --abort + CONFLICTED
- tsc 通过 + vitest 失败 → merge --abort + CONFLICTED
- 验证失败后 worktree 状态干净
```
