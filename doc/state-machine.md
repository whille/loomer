# Loomer 状态机

> 设计约束来源：conductor-ui `conductor/core/status.py`

## 9 种状态

| 状态 | 说明 | 是否终态 |
|------|------|---------|
| PENDING | 等待启动（计划任务或依赖未满足） | 否 |
| RUNNING | 进程运行中 | 否 |
| DONE | 进程正常退出（exit_code=0），待风险评估 | 否 |
| CRASHED | 进程异常退出（exit_code≠0） | 是 |
| CONFLICTED | merge 冲突，保留 worktree 供手动解决 | 是 |
| STALE | 运行超时（超过 timeout_minutes） | 是 |
| REVIEW | 风险评估为 HIGH，等待人工审查 | 是 |
| ACCEPTED | 审查通过，改动已合并 | 是 |
| REJECTED | 审查拒绝，改动已丢弃 | 是 |

## Dogfooding 教训

**exit_code 优先于日志启发式**: exit_code !== 0 必须 short-circuit 到 CRASHED，不能 fallthrough 到日志/文件启发式判断。否则 exit_code=1 但日志有内容的进程会被误判为 DONE。

**跨进程检测必须可靠**: CLI 启动的进程在 Web 服务重启后从内存中消失，必须通过 PID 检测作为后备。

**worktree 清理时机**: done() LOW→ACCEPTED 后 remove / accept()/reject() 后 remove / CONFLICTED 保留 / REVIEW 保留

**agent 不 commit**: merge 前必须 git add -A + auto-commit（agent 可能不 commit，导致 merge diff 为空、风险误判为 LOW）。→ 详见 [risk-assessment.md](risk-assessment.md)

**旧计划残留数据**: runPlan() 启动前必须清理旧 plan + 旧 agent，不能假设存储为空。→ 详见 [dag-scheduling.md](dag-scheduling.md)

**CWD 问题**: 所有 git 命令必须显式指定 cwd=worktree 绝对路径，不依赖 CWD。

**缺字段防御**: agent 数据可能缺少 pid/started_at/worktree 等字段，读取必须容错。→ 详见 [technical-decisions.md §8](technical-decisions.md)

## 状态转换图

```
PENDING ──start()──→ RUNNING
                      │
                      ├── timeout ──→ STALE ──kill()──→ DONE
                      │                        ──retry()──→ RUNNING
                      │
                      ├── exit_code=0 ──→ DONE ──done()──→ risk_check
                      │
                      ├── exit_code≠0 ──→ CRASHED ──retry()──→ RUNNING
                      │                           ──kill()──→ DONE
                      │
                      └── done()
                           │
                           ├── merge 冲突 ──→ CONFLICTED
                           │
                           └── merge 成功
                                │
                                ├── LOW + auto ──→ ACCEPTED
                                │
                                └── HIGH / always ──→ REVIEW ──accept()──→ ACCEPTED
                                                                ──reject()──→ REJECTED
```

## 转换触发条件

### RUNNING → 终态检测优先级（设计不变量）

1. **终态直返**: DONE/CONFLICTED/PENDING/REVIEW/ACCEPTED/REJECTED → 直接返回
2. **STALE 检测**: `started_at + timeout_minutes * 60 < now` → STALE
3. **同实例检测**: 内存中进程对象存活 → 仍为 RUNNING
4. **跨实例检测**: PID 存活检测 → 仍为 RUNNING
5. **exit_code 字段**（最权威，monitor 回写）:
   - `exit_code === 0` → DONE
   - `exit_code !== 0` → CRASHED（**short-circuit，不 fallthrough**）
6. **内存中 spawn 对象已 emit 'exit' 事件**:
   - `code === 0` → DONE
   - `code !== 0` → CRASHED
7. **日志有内容且进程已退出** → DONE
8. **worktree 有未提交变更** → auto-commit + DONE
9. **以上都不满足** → CRASHED

**不变量**: 优先级顺序是设计约束，具体检测手段因语言/平台而异。Node.js 中 `child.on('exit')` 替代 Python `proc.wait()`/`proc.poll()`，但 exit_code 作为权威来源的语义不变。

## Transition Callback

```typescript
setTransitionCallback(cb: (name: string, status: Status) => void): void
```

- 检测到 RUNNING→终态转换时自动触发
- 用于 PlanExecutor 依赖解析：任务完成 → 检查 PENDING 任务的依赖是否满足
- 回调异常不影响状态更新（catch + warning log）

## 跨实例状态检测

Web 服务重启后，内存中无进程对象，需通过 PID 判断存活：

**设计约束**: 必须有 PID 检测后备机制。

**Node.js 实现**: `process.kill(pid, 0)` — 0 信号只检查不发送，进程不存在时 throw。

## 进程退出码回写

**设计约束**: 进程退出时必须将 exit_code 写入状态存储（供跨实例检测）。

**Node.js 实现**: `child.on('exit', (code) => { state.updateAgent(name, { exit_code: code }) })`
