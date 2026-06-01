# ISS-022: 缺少安全路径测试 — Shell 注入路径无覆盖

## 严重级别

CRITICAL

## 位置

- `tests/app.test.ts` — 无恶意输入路径测试
- `tests/safety.test.ts` — validateName 测试了，但 app.ts 中的实际使用路径未测

## 描述

当前测试全部走合法输入路径，没有安全边界测试。已知注入点：

1. **`app.ts:503`** — `execSync(\`cat "${filePath}"\`)`，filePath 来自 git diff 输出，恶意文件名可注入
2. **`app.ts:608`** — `_createPr` 中 prompt 拼入 shell 命令，用户可控 prompt 含元字符
3. **`app.ts:451`** — `execSync(\`git merge ${name}\`)`，name 经 validateName 校验，但测试未验证校验在调用路径上的实际生效

## 缺失测试

```
- 冲突文件名含 shell 元字符（; | $() 等）→ 不执行注入命令
- prompt 含 shell 元字符 → gh pr create 不注入
- validateName 在 _mergeAgent 调用链上实际生效
```

## 修复方案

1. 对每个 execSync 调用点，构造含元字符的输入，验证不执行注入
2. 修复后（换用 execFileSync），测试验证参数数组传递
