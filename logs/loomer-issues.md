# Loomer Issue Log — dogv2 dogfooding

## Issue #1: WorkspaceManager 不处理已存在的 worktree/分支

**时间**: 2026-06-01
**严重度**: HIGH (阻塞 plan run)
**现象**: `loomer plan run` 重复运行时，`git worktree add -b TS-001` 失败。worktree 目录残留时也崩溃。
**根因**: `WorkspaceManager.create()` 未检查分支/worktree 是否已存在，也不清理残留目录。
**修复方案**: 添加 `worktreeExists()` 检查，幂等返回；残留目录自动清理 + prune。✅ 已修复

## Issue #2: LoomerApp 缺少 create() 工厂方法

**时间**: 2026-06-01
**严重度**: HIGH (TS 编译失败)
**现象**: `cli.ts` 调用 `new LoomerApp(config)`，但构造函数需要 4-6 个参数。
**根因**: CLI 入口缺少构建依赖的工厂方法。
**修复方案**: 添加 `LoomerApp.create(config)` 静态方法。✅ 已修复

## Issue #3: risk_assessment 类型不匹配

**时间**: 2026-06-01
**严重度**: MEDIUM (TS 编译失败)
**现象**: `AgentData.risk_assessment` 类型为 `Record<string, unknown>`，但 `AgentInfo` 需要 `RiskAssessmentData`。
**根因**: state.ts 和 cli-client.ts 中 JSON.parse 的 cast 类型不正确。
**修复方案**: 统一使用 `RiskAssessmentData` 类型。✅ 已修复

## Issue #4: startServer 未捕获 EADDRINUSE

**时间**: 2026-06-01
**严重度**: HIGH (进程崩溃)
**现象**: 端口被占用时 Express listen 抛出 unhandled error event，LoomerApp 进程崩溃。
**根因**: `startServer()` 未监听 server error 事件。
**修复方案**: 监听 error 事件，EADDRINUSE 时优雅降级（不启动 dashboard 但不崩溃）。✅ 已修复

## Issue #5: 子进程 PATH 缺少 bun 等工具路径

**时间**: 2026-06-01
**严重度**: HIGH (agent 无法启动)
**现象**: ProcessManager spawn claude 时，kscc 需要 bun 但找不到 `spawnSync bun ENOENT`。
**根因**: `spawn()` 继承 process.env 但 `~/.bun/bin` 不在 PATH 中。
**修复方案**: ProcessManager.start() 构建增强 PATH，追加 `~/.bun/bin` 等常见目录。✅ 已修复

## Issue #6: runPlan 预创建 worktree 后 start() 重复创建

**时间**: 2026-06-01
**严重度**: MEDIUM (逻辑冗余)
**现象**: `runPlan()` 第 259-266 行预创建 worktree，然后 `start()` 第 91 行再次调用 `create()`。
**根因**: 双重创建逻辑，当 create 不幂等时会崩溃。
**修复方案**: Issue #1 的幂等修复使双重创建安全。无需额外改动。

## Issue #7: _mergeAgent 在 worktree 中 merge 但结果未回主仓库

**时间**: 2026-06-01
**严重度**: CRITICAL (合并代码丢失)
**现象**: TS-001 ACCEPTED 后，主仓库 master 分支没有 TS-001 的代码。`_mergeAgent()` 在 worktree 目录中执行 `git checkout master && git merge TS-001`，但 worktree 的 master 和主仓库的 master 是不同的 HEAD。merge 结果只存在于 worktree 的 .git 链接中，worktree 清理后代码丢失。
**根因**: git worktree 中 `git checkout master` 切换的是 worktree 自身的分支指针，不会影响主仓库。正确做法是在主仓库中 `git merge TS-001`，或者在 worktree 中 merge 后 push 到主仓库。
**修复方案**: 在 `_mergeAgent()` 中，改用 `git -C <repoPath> merge <name>` 在主仓库执行合并，而非在 worktree 中。✅ 已修复

## Issue #8: Web DAG 可视化严重缺失

**时间**: 2026-06-01
**严重度**: HIGH (UI 体验差)
**现象**: Loomer DAG 用 flex-wrap div 渲染，只是带颜色徽章 + 文本边列表，无空间布局、无箭头、无拓扑排序。Conductor UI 有完整 SVG DAG（拓扑分层、贝塞尔曲线、箭头、点击高亮）。
**修复方案**: 重写 DAG 渲染为 SVG，参考 Conductor UI 的 BFS 分层 + bezier 边实现。

## Issue #9: 缺少进度条

**时间**: 2026-06-01
**严重度**: MEDIUM (UI 体验差)
**现象**: Plan 进度只显示文本，无进度条和百分比。
**修复方案**: 添加进度条 DOM + CSS 动画。

## Issue #10: 缺少关键操作按钮

**时间**: 2026-06-01
**严重度**: MEDIUM (功能缺失)
**现象**: DONE/CRASHED/STALE 状态无操作按钮。后端路由已存在但前端 ACTIONS map 未映射。
**修复方案**: 补全 ACTIONS 映射。

## Issue #11: Plan 更新用轮询而非 SSE

**时间**: 2026-06-01
**严重度**: LOW (性能)
**现象**: Plan 进度每 5s 轮询，不随 SSE 实时更新。
**修复方案**: SSE status 变化时也调用 loadPlan()。

## Issue #12: 缺少统计色点

**时间**: 2026-06-01
**严重度**: LOW (视觉)
**现象**: Plan 统计只有文本，无色点。
**修复方案**: 添加 stat-dot 色点元素。

## Issue #15: 主进程在 agent 运行中退出，done() 永不触发

**时间**: 2026-06-01
**严重度**: CRITICAL (代码丢失)
**现象**: Loomer 主进程在 agent 子进程仍在运行时退出。StatusDetector 5s 轮询可能未检测到运行中的 agent，或主进程的退出条件判断错误。agent 写了代码但 done() 从未触发，代码留在 worktree 中无法 merge 到 master。
**根因**: 待排查。可能原因：(1) StatusDetector 轮询间隔期间 agent 状态更新未同步 (2) 主进程退出条件"无活跃 agent"的判断不准确 (3) Node.js 事件循环中子进程句柄未阻止退出
**修复方案**: 主进程必须持有子进程引用，Node.js 事件循环在有活跃子进程时不应该退出。需要 `child.unref()` 的反向保证——确保 ProcessManager 持有的子进程阻止主进程退出。

## Issue #13: Agent prompt 缺少 acceptance criteria，导致交互式提问

**时间**: 2026-06-01
**严重度**: CRITICAL (agent 不写代码)
**现象**: kscc 在非交互模式 (`-p`) 运行时，prompt 只有一句话描述，agent 不知道具体要做什么，用 AskUserQuestion 提问后无人回答，直接结束（exit_code=0），实际没写代码。
**根因**: `PlanParser.fromPrdJson()` 只取 `userStory.description` 作为 prompt，未包含 `acceptanceCriteria`。非交互模式下 agent 无法获得足够上下文。
**修复方案**: 在 prompt 中注入 acceptance criteria + "不要提问，直接实现" 指令。✅ 已修复

## Issue #14: _mergeAgent 的 "无变更" 判断过于激进

**时间**: 2026-06-01
**严重度**: HIGH (代码丢失)
**现象**: Agent 写了代码但 _mergeAgent 中 `git diff --cached --quiet` 成功（无变更），跳过 commit 和 merge。
**根因**: Agent 可能已经自行 commit（导致 staged 无 diff），或 .gitignore 排除了文件。应改用 `git diff HEAD` 或 `git status --porcelain` 判断。
**修复方案**: 用 `git status --porcelain` 判断是否有未提交变更，替代 `git diff --cached --quiet`。
