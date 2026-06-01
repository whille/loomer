# Loomer E2E 集成测试

## 目的

用两个真实项目驱动 Loomer 完整流水线，验证从 PRD 到计划完成的全链路可用性。

## 测试矩阵

| 项目 | 规模 | 预估耗时 | 核心验证点 |
|------|------|---------|-----------|
| mini-greet | 4 task / 4 US | ~5 min | 快速冒烟：DAG 并行、冲突自动解决、LOW 自动合并 |
| dogv2 | 5 task / 5 US | ~20 min | 完整流程：多文件合并、HIGH 风险 REVIEW、依赖解锁、文档更新 |

---

## 测试 #1: mini-greet（快速冒烟）

### 设计思路

最小可运行项目，3 个源文件 + 测试 + README，无数据库无框架。核心设计点：

**1. DAG 并行执行**
```
TS-000 (scaffold)
    ├── TS-001 (greet module) ──┐
    └── TS-002 (CLI entry)  ───┤
                               └── TS-003 (README)
```
TS-001 和 TS-002 并行，验证 Loomer 的 maxConcurrent 调度和 DAG 依赖解析。

**2. 故意制造 package.json 冲突**

TS-001 需修改 package.json 添加 `exports` 字段，TS-002 需添加 `bin` + `start` script。两者并行修改同一个文件，必然触发 merge 冲突。

这是 Loomer `§6.1 Merge 冲突自动解决` 的关键验证点：
- package.json 冲突 → 自动合并 dependencies/devDependencies 并集
- 合并后 `tsc --noEmit` 验证
- 验证通过 → 自动 commit → 继续 DONE 流程

**3. LOW 风险自动合并**

所有 task 都是纯新增或小改动（< 5 文件, < 200 行），预期全部 LOW → auto ACCEPTED + worktree 清理。验证无人干预的完整闭环。

**4. 依赖解锁**

TS-003 依赖 TS-001 + TS-002，两者都 ACCEPTED 后 TS-003 才启动。验证 DAG onTaskDone 回调正确触发。

### 覆盖的 Loomer 环节

| # | 环节 | 覆盖 |
|---|------|------|
| 1 | PRD 解析（prd.json） | ✅ |
| 2 | DAG 验证（4 task, 有依赖） | ✅ |
| 3 | Worktree 创建（4 个） | ✅ |
| 4 | 并行 agent 执行（TS-001 ∥ TS-002） | ✅ |
| 5 | DONE 检测（exit_code=0, auto-commit） | ✅ |
| 6 | LOW 风险 → ACCEPTED + 清理 | ✅ |
| 7 | Merge 冲突 → package.json 并集自动解决 | ✅ |
| 8 | 冲突后验证（tsc --noEmit） | ✅ |
| 9 | DAG 依赖解锁（TS-003） | ✅ |
| 10 | 计划完成检测 | ✅ |

### 未覆盖（需 dogv2 补充）

| 环节 | 原因 |
|------|------|
| HIGH 风险 → REVIEW → Accept/Reject | mini-greet 全是 LOW |
| 多文件大改动合并 | 每个任务改动很小 |
| 并发 merge 互斥锁 | 只有 TS-001+TS-002 可能同时 merge，但 TS-000 先完成 |
| CRASHED → Retry | 设计无法保证 agent 崩溃 |
| STALE 超时 | 每个任务 < 2 分钟，不会超时 |

---

## 测试 #2: dogv2（完整流程）

### 设计思路

真实项目：Express + EJS + SQLite 的阅读追踪 Web App。5 个 task，含数据层、Web 路由、CLI、响应式 CSS、文档。比 mini-greet 复杂度高一个量级。

**1. 串行骨架 + 并行功能 + 串行收尾**

```
TS-000 (scaffold: types, db, package.json)
    ├── TS-001 (Express 路由 + 全部页面) ──┐
    ├── TS-002 (CLI 入口) ────────────────┤
    └── TS-003 (响应式 CSS) ──────────────┤
                                          └── TS-004 (文档更新)
```

**2. HIGH 风险路径**

TS-001（Express 路由 + 全部页面）是最大的 task，改动文件数 > 5（routes, templates, static files），预期触发：
- file_count 信号 HIGH
- public_modules 信号 HIGH（改 src/ 下文件）
- 整体 HIGH → REVIEW 状态

这验证了 Loomer `§6 done() 流程` 中的 HIGH → REVIEW + 创建 PR 路径，以及 Accept/Reject 人工决策。

**3. 多文件 merge 冲突**

上一轮 dogfooding 暴露：7 个 task 都改 package.json 导致冲突。本轮已优化（合并数据层+路由为一个 task），但 TS-001/002/003 仍可能共享文件，验证冲突处理。

**4. 依赖任务 rebase**

TS-001/002/003 启动时需要 rebase 到 TS-000 完成后的最新 master，获取上游代码。验证 `§7 DAG 调度` 约束 8。

**5. TS-004 必须最后执行**

文档更新依赖所有功能 task，验证 DAG 终态检测和级联完成。

### 覆盖的 Loomer 环节（补充 mini-greet 未覆盖的）

| # | 环节 | 覆盖 |
|---|------|------|
| 1 | HIGH 风险 → REVIEW + PR 创建 | ✅ TS-001 |
| 2 | Accept（REVIEW → ACCEPTED + 清理） | ✅ 需人工操作 |
| 3 | Reject（REVIEW → REJECTED） | ✅ 可手动测试 |
| 4 | 多文件 merge（> 5 文件） | ✅ TS-001 |
| 5 | 依赖任务 rebase | ✅ TS-001/002/003 |
| 6 | 并发 merge 互斥锁 | ✅ 3 个并行 task 可能同时 merge |
| 7 | Web Dashboard 实时展示 | ✅ 全程可观测 |
| 8 | SSE 状态推送 | ✅ 全程可观测 |

### 上一轮 dogfooding 教训（已内化到 PRD）

| 教训 | 本轮对策 |
|------|---------|
| agent 类型定义不一致 | TS-000 首先创建统一 types.ts |
| 7 个 task 都改 package.json | 合并数据层+路由为一个大 task（TS-001） |
| build 通过但启动崩溃 | 每个 US 完成后必须 `npm run build && node dist/cli.js serve` 验证 |
| 缺末尾文档更新 | TS-004 最后执行，汇总所有变更 |

---

## 执行方式

```bash
# 测试 #1: mini-greet（~5 min）
mkdir -p /tmp/mini-greet && cd /tmp/mini-greet
git init
# 手动创建一个初始 commit（Loomer 需要干净 git 仓库）
echo "# mini-greet" > README.md && git add . && git commit -m "init"
# 用 Loomer 运行
cd /Users/wangzhiguo/github.com/loomer
bun run src/cli.ts plan run --prd /Users/wangzhiguo/github.com/loomer/tests/e2e/fixtures/mini-greet/prd.json

# 测试 #2: dogv2（~20 min）
mkdir -p /tmp/dogv2 && cd /tmp/dogv2
git init
echo "# dogv2" > README.md && git add . && git commit -m "init"
cd /Users/wangzhiguo/github.com/loomer
bun run src/cli.ts plan run --prd /Users/wangzhiguo/github.com/loomer/tests/e2e/fixtures/dogv2/prd.json
```

## 验证清单

### mini-greet 完成后检查

- [ ] `cd /tmp/mini-greet && npm run build` 通过
- [ ] `node dist/cli.js greet World --lang zh` 输出 "你好, World!"
- [ ] `npx vitest run` 3 个测试通过
- [ ] `git log --oneline` 有 4 个 merge commit（每个 task 一个）
- [ ] 所有 worktree 已清理（`git worktree list` 只剩主 worktree）
- [ ] Web dashboard 显示计划 100% 完成

### dogv2 完成后检查

- [ ] `cd /tmp/dogv2 && npm run build` 通过
- [ ] `node dist/cli.js serve --port 3000` 可启动
- [ ] `curl localhost:3000/` 返回 200
- [ ] 添加书籍 → 查看详情 → 更新进度 → 标记完成 全流程可用
- [ ] HIGH 风险 task 进入了 REVIEW 状态（需要 Accept）
- [ ] `npx vitest run` 通过
- [ ] 移动端布局正常（浏览器 DevTools 模拟）
- [ ] README 和 CLAUDE.md 内容完整

## 两个项目的覆盖互补

```
              mini-greet    dogv2
DAG 并行         ✅           ✅
冲突自动解决      ✅           ✅
LOW 自动合并     ✅           ✅
HIGH → REVIEW    ❌           ✅
Accept/Reject    ❌           ✅
并发 merge       ❌           ✅
多文件大改动      ❌           ✅
依赖 rebase      ❌           ✅
Web Dashboard    ✅           ✅
计划完成检测      ✅           ✅
```

mini-greet 是快速冒烟（5 分钟验证核心链路），dogv2 是完整验证（20 分钟覆盖所有环节）。两者互补，不应只用一个。
