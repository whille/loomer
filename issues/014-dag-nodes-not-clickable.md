# ISS-014: Web Dashboard DAG 节点不可点击

## 严重级别

LOW

## 位置

- `public/app.js:476-495` — SVG 节点渲染

## 描述

DAG SVG 可视化创建了节点，但没有绑定任何点击事件。用户无法从 DAG 视图直接操作 agent（查看日志、查看 diff 等）。也没有 hover tooltip 显示 agent 详情。

## 修复方案

1. 给 SVG 节点添加 click handler → 打开对应 agent 的 log modal
2. 添加 hover → tooltip 显示 agent 名称、状态、运行时长
