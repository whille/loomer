# Loomer — 从 PRD 到代码的自动化织机

## 产品定义

Loomer 是一个开源的 AI coding agent 编排工具。从 PRD 出发，自动拆分任务、DAG 并行调度、风险分级审查、自动 merge/PR。

**核心隐喻：** 织布机（loom）— PRD 是经线，agent 是纬线，DAG 是编织图案，审查门禁是质检站。

参考了 [conductor.build](https://conductor.build) app 的多 agent 编排理念。

## 技术栈

- **语言：** Node.js 18+ (ESM)
- **Web：** Express + EJS
- **CLI：** Commander.js
- **数据：** SQLite (better-sqlite3, WAL 模式)
- **测试：** Vitest
- **进程：** child_process.spawn + stream-json pipe
- **配置：** JSON (全局 ~/.loomer/config.json + per-project .loomer.json)

## 为什么选 Node.js

1. kscc 本身是 Node.js 进程，`child_process.spawn` 天然 pipe stream-json
2. 无需 worker.log 中转，直接 `--output-format stream-json` 实时输出
3. 前端生态统一（EJS/highlight.js/diff2html）
4. 并发模型：event loop 比 Python threading 更适合 I/O 密集的 agent 监控

## 核心机制

### 状态机

9 种状态，自动检测进程存活、超时、exit code，触发 transition callback 驱动 DAG 依赖解析。
详见 [状态机设计](state-machine.md)

### 风险分级审查

6 个风险信号自动评估（文件数/行数/新文件/公共模块/冲突/测试），LOW 自动 merge，HIGH 进 REVIEW。
详见 [风险分级审查](risk-assessment.md)

### PRD 驱动 DAG 调度

prd.json → PlanParser → DAGValidator（无环/无缺引用）→ PlanExecutor（maxConcurrent + 依赖解析）
详见 [DAG 调度设计](dag-scheduling.md)

## 设计文档

**入口**: [design-spec.md](design-spec.md) — 设计主线（10 个模块的设计约束 + 阅读线索），只记录 what & why，不固定 how

| 文档 | 性质 | 内容 |
|------|------|------|
| [design-spec.md](design-spec.md) | 设计主线 | 11 模块设计约束 + Dogfooding 教训 + 阅读顺序 |
| [api-spec.md](api-spec.md) | 接口签名 | 11 模块 TypeScript API 规格 |
| [state-machine.md](state-machine.md) | 状态模型 | 9 种状态 + 转换规则 + 检测优先级 |
| [risk-assessment.md](risk-assessment.md) | 审查模型 | 6 风险信号 + merge 策略 + done 流程 |
| [technical-decisions.md](technical-decisions.md) | 技术决策 | 7 个技术决策 + 22 条 dogfooding 教训 |
| [dag-scheduling.md](dag-scheduling.md) | 调度模型 | prd.json 格式 + DAG 验证 + 依赖解析 |
| [web-and-sse.md](web-and-sse.md) | 交互模型 | REST API + SSE + 仪表盘 |
| [local-dev-workflow.md](local-dev-workflow.md) | 开发调试 | 安装、调试迭代、命令速查 |
