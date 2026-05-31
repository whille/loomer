# Loomer 本地开发 & 调试

## 安装方式

**不需要全局 `npm install -g`**，推荐 `bun link`：

```bash
cd <loomer-dir>
bun link
```

这会注册一个全局符号链接，`loomer` 命令指向本地 `dist/cli.js`。

## 代码变更后的调试迭代

### 方式 A：build + link（常规开发）

```bash
# 改完 loomer 代码后
cd <loomer-dir>
bun run build          # tsc 编译 → dist/

# 目标项目里立刻用
cd <target-project>
loomer plan status     # 已是最新代码
```

### 方式 B：直接跑 TS 源码（跳过 build）

适合纯逻辑修改、不涉及类型签名变化时：

```bash
cd <loomer-dir>
bun run src/cli.ts plan run --prd /path/to/prd.json
```

省去编译步骤，Bun 直接执行 TS。

### 方式 C：不注册 link，显式路径调用

不改全局环境：

```bash
cd <target-project>
bun run <loomer-dir>/src/cli.ts plan run --prd tasks/prd.json
```

## 典型开发循环

```
1. 修改 loomer 源码（src/*.ts）
2. bun run build                  # 编译
3. bun test                       # 跑测试（可选）
4. cd <target-project>
5. loomer plan run --prd <prd-path>   # 验证
6. 观察 Web 仪表盘 http://localhost:3000
7. 发现问题 → 回到步骤 1
```

## 常用命令速查

```bash
# Loomer 开发
cd <loomer-dir>
bun run build                       # 编译 TS
bun test                            # 跑测试
bun run check                       # 类型检查 + lint

# 目标项目执行
cd <target-project>
loomer plan run --prd tasks/prd.json  # 启动计划
loomer plan status                     # 查看进度
loomer status                          # 列出 agent
loomer done <name>                     # 风险分级 merge

# worktree 管理
git worktree list                      # 列出所有 worktree
git worktree remove <name>             # 清理已完成 worktree
```
