# ISS-017: Inline Comments → Agent 反馈闭环

## 严重级别

MEDIUM

## 来源

Conductor 技术分析 §4.1.1

## 位置

- `src/web.ts` — Web dashboard diff view（只读，无交互）

## 描述

Conductor 的 Diff Viewer 支持 inline comments 自动转为 agent attachment，形成 review → agent fix 的闭环。Loomer 的 Web dashboard 有 diff view 但只是只读展示，无法在 diff 中评论并反馈给 agent。

REVIEW 状态时，人需要：看 diff → 发现问题 → 手动在 CLI 或别处告诉 agent → agent 修复。这个流程切换成本高。

## 实现思路

1. diff view 中增加行级评论功能（每行一个 "+" 按钮）
2. 评论数据存入 StateStore（SQLite 新增 review_comments 表）
3. 通过 ProcessManager 向 agent stdin 注入评论内容（或重启 agent 并附加评论 prompt）
4. agent 收到评论后自主修复，状态转为 RUNNING
5. Web API 新增 `POST /api/review/<name>/comment` 和 `GET /api/review/<name>/comments`

## 参考

- Conductor: inline comments → composer attachment → agent 闭环
- 当前 diff view 已有基础，需要加交互层
