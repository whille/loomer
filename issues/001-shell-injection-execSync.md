# ISS-001: Shell 命令注入 — execSync 字符串插值

## 严重级别

CRITICAL

## 位置

- `src/app.ts:503` — `execSync(\`cat "${filePath}"\`)`，filePath 来自 git diff 输出，未校验
- `src/workspace.ts:54` — `execSync(\`git worktree remove "${worktreePath}"\`)`
- `src/workspace.ts:63` — `execSync(\`git branch -D "${name}"\`)`

## 描述

多处使用 `execSync` + 字符串插值执行 shell 命令，参数来自 git 输出或配置。构造恶意文件名（如 `"; rm -rf /; echo "`）可突破引号注入任意命令。

`process.ts` 中已正确使用 `execFileSync`（参数数组），但 `app.ts` 和 `workspace.ts` 仍用不安全的字符串插值。

## 修复方案

| 位置 | 修复 |
|------|------|
| `app.ts:503` | 替换为 `fs.readFileSync(filePath, "utf-8")`，无需 shell |
| `workspace.ts:54` | 替换为 `execFileSync("git", ["worktree", "remove", worktreePath])` |
| `workspace.ts:63` | 替换为 `execFileSync("git", ["branch", "-D", name])` |

## 参考

- commit `e95d049` 修复过同类命令注入问题
- `src/process.ts` 已使用安全的 `execFileSync` 模式
