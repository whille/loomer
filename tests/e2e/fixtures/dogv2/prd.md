# PRD: dogv2 — Reading Tracker

## Introduction

个人阅读进度追踪工具。Express + EJS Web UI + CLI 入口，核心 CRUD（添加书籍、更新进度、标记完成/放弃、阅读笔记），统计卡片，响应式布局。SQLite 存储。

本项目实际目的是 **dogfooding Loomer**：验证 PRD → DAG 并行执行 → 审查门禁 → merge 完整流水线。

上一轮 dogv2 暴露的问题及对策：
- agent 类型定义互相不一致 → TS-000 首先创建 CLAUDE.md + 统一类型文件
- 7 个 task 都改 package.json 导致 merge conflict → 合并数据层+路由为一个大 US，减少共享文件
- build 通过但启动崩溃 → 每个 US 完成后必须 `npm run build && node dist/cli.js serve` 启动验证
- 缺少末尾文档更新 → 旧项目增加 TS-LAST

## Goals

- Express + EJS Web UI 提供完整 CRUD 交互
- CLI 入口 `node dist/cli.js serve --port 3000` 启动 Web 服务器
- SQLite 数据层（better-sqlite3，独立设计，不兼容 Python 版）
- 响应式 CSS，移动端友好
- 统计卡片（总书数、月完成、平均评分）
- 每个 US 完成后可实际启动并验证功能

## User Stories

### US-000: 项目骨架与文档
**Description:** 作为开发者，我需要项目初始化和统一约定，确保后续 agent 写出一致的代码。

**Acceptance Criteria:**
- 创建 CLAUDE.md：技术栈（Node.js + Express + EJS + better-sqlite3 + TypeScript + commander + vitest）、目录结构约定、编码规范（snake_case DB 字段、类型定义在 src/types.ts）
- 创建 README.md：项目说明、启动命令
- 初始化 package.json（name: dogv2, type: module, scripts: build/dev/start/test）
- 创建 tsconfig.json（target ES2022, module NodeNext, outDir dist, 严格模式）
- 创建 src/types.ts：导出 Book/Note/BookStatus/Stats/Db 接口（所有字段 snake_case）
- 创建 src/db.js：SQLite 数据层实现 Db 接口的所有方法（initDb/addBook/getBook/listBooks/updateProgress/finishBook/dropBook/addNote/getNotes/getStats）
- `npm run build` 通过且 `node dist/cli.js serve --port 3000` 可启动（首页返回 200）
- vitest 测试覆盖 Db 接口 CRUD（:memory: DB）

### US-001: Express 路由 + 全部页面
**Description:** 作为用户，我通过 Web UI 完成所有阅读追踪操作。

**Acceptance Criteria:**
- `src/app.ts` 导出 `createApp(db: Db): Express.Application`
- 路由实现：GET /（首页统计+书籍列表）、GET /books/add（表单）、POST /books（添加）、GET /books/:id（详情）、POST /books/:id/progress、POST /books/:id/finish、POST /books/:id/drop、POST /books/:id/notes
- EJS 模板：index.ejs（首页）、add-book.ejs（表单，values 对象传递）、book-detail.ejs（详情+操作）、404.ejs
- 静态文件服务（style.css）
- 404 处理中间件
- 首页：统计卡片（总书数/月完成/平均评分）+ 书籍表格（书名/作者/进度条/状态徽章）
- 添加表单：验证必填字段，错误时回显输入值，成功后重定向到详情页
- 详情页：进度条（current/total + 百分比）、状态徽章、评分、笔记列表（按页码排序）、操作按钮
- `npm run build` 通过且 `node dist/cli.js serve --port 3000` 可启动，所有路由返回正确状态码
- 类型检查通过

### US-002: CLI 入口
**Description:** 作为高级用户，我通过命令行启动 Web 服务器。

**Acceptance Criteria:**
- `src/cli.ts` 使用 commander 解析 CLI 参数
- `node dist/cli.js serve [--port 3000]` 启动 Web 服务器
- 默认端口 3000，可通过 --port 指定
- 启动时输出访问地址
- `npm run build` 通过且 `node dist/cli.js serve` 可启动
- 类型检查通过

### US-003: 响应式布局 + CSS
**Description:** 作为用户，我在手机和桌面端都能正常使用。

**Acceptance Criteria:**
- 纯手写 CSS（无框架），响应式布局
- 桌面端：表格布局
- 移动端：卡片式布局 + 统计卡片堆叠
- 触摸目标 ≥ 44px
- 进度条颜色：reading→蓝色，finished→绿色，dropped→红色
- `node dist/cli.js serve` 启动后，浏览器验证桌面端和移动端布局
- 类型检查通过

### US-004: 文档更新
**Description:** 作为开发者，我需要更新项目文档反映所有变更。

**Acceptance Criteria:**
- 更新 CLAUDE.md 反映新增/变更的模块、接口、数据模型
- 更新 README.md 反映实际启动命令和功能
- 类型检查通过

## Functional Requirements

- FR-1: SQLite 数据层实现 Db 接口所有方法，better-sqlite3 同步 API
- FR-2: `initDb()` 幂等（IF NOT EXISTS），启用 PRAGMA foreign_keys = ON
- FR-3: `addBook()` 设置 status='reading', current_page=0, started_at=created_at=now
- FR-4: `updateProgress()` 验证 page ∈ [0, total_pages]
- FR-5: `finishBook()` 设置 status='finished', current_page=total_pages, finished_at=now，可选 rating ∈ [1,5]，幂等
- FR-6: `dropBook()` 设置 status='dropped' + updated_at=now，幂等
- FR-7: `addNote()` 验证 content 非空白、book_id 存在
- FR-8: `getNotes()` 按 page 升序，NULL 排最后
- FR-9: `getStats()` 返回 monthly_finished, avg_rating, total_books
- FR-10: Express `createApp(db)` 工厂函数，返回可测试的 app 实例
- FR-11: 所有路由功能完整实现
- FR-12: 响应式 CSS，移动端卡片式，桌面端表格

## Non-Goals

- 不做 Python 版兼容（独立 SQLite 设计）
- 不做 Markdown 导出
- 不做独立统计页面
- 不做用户认证/多用户
- 不做在线同步/云存储
- 不做 ISBN 搜索
- 不做实时推送（SSE/WebSocket），手动刷新即可
- 不做前端 SPA/React（纯 EJS 服务端渲染）

## Technical Considerations

- SQLite: better-sqlite3（同步 API，WAL 模式）
- DB 路径: `~/.reading-tracker/tracker.db`，目录不存在时自动创建
- Web: Express + EJS 模板引擎
- CLI: commander
- 构建: tsc → dist/，`"type": "module"` in package.json
- 入口: `node dist/cli.js serve`
- 测试: vitest + :memory: SQLite
- 时间字段: 全部 ISO 8601 字符串
- 类型定义: 集中在 src/types.ts，所有字段 snake_case
- 无 ORM，原生 SQL

## Success Metrics

- Loomer DAG 完整流水线验证通过（所有 task ACCEPTED）
- 所有 CRUD 操作 Web UI 可用
- 每个 US 完成后可启动验证
- 移动端和桌面端布局正常
- 测试覆盖 CRUD 核心路径

## Open Questions

- 无

## 任务拆分

### TS-000: 项目骨架与文档
- 对应: US-000
- 依赖: 无
- 可并行: 否（所有 task 依赖此 task）
- 分支: feat/project-scaffold
- 共享文件: package.json, tsconfig.json, src/types.ts

### TS-001: Express 路由 + 全部页面
- 对应: US-001
- 依赖: TS-000
- 可并行: 是（TS-000 完成后）
- 分支: feat/express-pages

### TS-002: CLI 入口
- 对应: US-002
- 依赖: TS-000
- 可并行: 是（TS-000 完成后，与 TS-001 并行）
- 分支: feat/cli-entry

### TS-003: 响应式布局 + CSS
- 对应: US-003
- 依赖: TS-000
- 可并行: 是（TS-000 完成后，与 TS-001/002 并行）
- 分支: feat/responsive-css

### TS-004: 文档更新
- 对应: US-004
- 依赖: TS-001, TS-002, TS-003
- 可并行: 否（必须最后执行）
- 分支: feat/doc-update
