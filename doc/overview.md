# Loomer — 从 PRD 到代码的自动化织机

## 产品定义

Loomer 是一个开源的 AI coding agent 编排工具。从 PRD 出发，自动拆分任务、DAG 并行调度、风险分级审查、自动 merge/PR。

**核心隐喻：** 织布机（loom）— PRD 是经线，agent 是纬线，DAG 是编织图案，审查门禁是质检站。

## 与 Conductor.build 的定位差异

| 维度 | Conductor | Loomer |
|------|-----------|--------|
| 入口 | 手动创建 agent | PRD 自动拆分 → DAG 调度 |
| 审查 | 人看 diff | 风险信号自动分级，人只看 HIGH |
| 平台 | macOS only | macOS + Linux |
| 开源 | 闭源 | 完全开源 |
| 流水线 | 无 | `/prd` → prd.json → `loomer plan run --prd` → DAG → 审查 → merge/PR |

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

## 与 conductor-ui (Python) 的关键差异

| 模块 | Python 方案 | Loomer 方案 | 改进点 |
|------|-----------|-------------|--------|
| 进程管理 | subprocess.Popen + worker.log 文件 | child_process.spawn + stream-json pipe | 实时输出，无需轮询文件 |
| 状态持久化 | JSON 文件 + fcntl.flock | SQLite WAL 模式 | 无需 fcntl，跨平台原子写入 |
| 跨进程锁 | fcntl.flock（Linux/Mac only） | SQLite WAL + 乐观锁 | 跨平台，Node.js 无 fcntl |
| Web 层 | Flask + Jinja2 | Express + EJS | 同生态，模板语法相似 |
| 配置 | 全局 config.json | 全局 + per-project `.loomer.json` | 多项目不冲突 |
| Agent 生命周期 | 无归档 | Archive 机制（active/archived 分离） | 列表清爽 |
| PR 创建 | 无 | `gh pr create` 自动创建 | REVIEW 时自动创建 PR |

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
| [api-spec.md](api-spec.md) | 接口签名 | 12 模块 TypeScript API 规格 |
| [state-machine.md](state-machine.md) | 状态模型 | 9 种状态 + 转换规则 + 检测优先级 |
| [risk-assessment.md](risk-assessment.md) | 审查模型 | 6 风险信号 + merge 策略 + done 流程 |
| [technical-decisions.md](technical-decisions.md) | 技术决策 | Python→Node 7 个决策对比 + 10 条 dogfooding 教训 |
| [dag-scheduling.md](dag-scheduling.md) | 调度模型 | prd.json 格式 + DAG 验证 + 依赖解析 |
| [web-and-sse.md](web-and-sse.md) | 交互模型 | REST API + SSE + 仪表盘 |
