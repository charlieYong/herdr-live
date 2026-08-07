---
name: herdr-live
description: "在 Herdr 里轻量地起多个真交互式 agent(cursor/claude/codex)并行跑、喂 prompt、读输出/状态的 live 编排。当你需要多 agent 对练/双端协商/多方案并行/批量同构任务,且不需要验收门禁与证据链时使用。不要用于:只想后台跑命令(用 herdr 本体)、需要正式验收编排(用 herdr-supervisor)、headless 无人值守(用 claude -p/SDK)。要求 HERDR_ENV=1。"
---

# herdr-live

通用多 agent live 编排工具:起 N 个真 harness agent、喂 prompt、读输出/状态。是 herdr
底层 CLI 的一层薄封装,把易错的底层序列变成语义明确的五个动词。工具在独立工程
`~/charlie/herdr-live`;完整用法见其 `README.md`,设计见 `design.md`,典型场景见 `scenarios.md`。

## ⛔ 投喂红线（先看这个）

**投喂必须用 `herdr-live prompt` / 库 `submitPrompt`。禁止只用 `herdr agent prompt` 当投喂。**

| 反模式 | 正确做法 |
|---|---|
| ❌ `herdr agent prompt <target> <text>` 然后当已发送 | ✅ `$HL prompt …` 或 `submitPrompt({ target, text\|file\|briefFile })` |
| ❌ 只填充输入框、自己拼底层五动词「差不多就行」 | ✅ 让 version profile 独占 Enter 决策并返回结构化 receipt |
| ❌ 叫醒场景有 pane_id 就直接 raw prompt | ✅ `submitPrompt({ target: 'w3:p16', … })`（无台账也必须加锁、按版本提交并确认） |

官方 Herdr 0.7.5 的 `herdr agent prompt` = **只填充、不提交**。其它版本不得猜测，
必须由 profile 决定。假成功（框里有字、agent 仍 idle）会害编排者以为已叫醒/已派活。

生产契约：官方 Herdr 0.7.5 profile 执行 prompt→settle→显式 Enter；
`core-managed-enter` 禁止二次 Enter；unknown fail-closed。Receipt 只有
`lifecycle_observed` 表示观察到本次之后的新 lifecycle 证据。仅 `not_sent` 可有界重试；
`ambiguous`、missing/malformed 或其它 post-transport 相位禁止自动重发。

## 前置(先验,不过就停手)

必须在 Herdr pane 内运行:

```bash
test "${HERDR_ENV:-}" = 1
```

不过就说明不在 Herdr 内,停止并说明——herdr-live 的所有动词都依赖 herdr CLI 操作当前 session。

## 定位边界(先判断该不该用本工具)

- **不替代 herdr-supervisor**:herdr-live **无验收门禁**——不做 task 冻结、accept、证据 digest、
  reviewer/verifier 角色链。需要有约束力的验收编排时用 `herdr-supervisor`,不要用本工具硬凑。
- **不替代 herdr 本体**:只想后台跑命令 / 管理终端布局,用 `herdr`;herdr-live 是"起 agent 做编排"。
- **不发明状态机**:agent 生命周期状态直接透传 herdr 的 `idle` / `working` / `done` / `blocked`。
- **中性通用**:是否在 agent 间中继消息、如何基于输出决策,由**调用者**定;工具不预设领域约束。

## 五个动词(推荐 PATH；无 PATH 时用单路径 `$HL`)

优先：`~/.local/bin/herdr-live` → `bin/herdr-live.js` 的 symlink（或 `npm` bin），直接 `herdr-live …`。
无 PATH 时：`$HL` **只存带 shebang 的单可执行路径**——**禁止**把 `node` 与脚本路径拼进同一 `$HL` 变量（zsh 默认不拆词，整串会当命令名失败）。

```bash
# 推荐（已在 PATH 时）
herdr-live list

# 或单路径变量（bash/zsh 皆安全）
HL="$HOME/charlie/herdr-live/bin/herdr-live.js"

$HL spawn <name> --kind <cursor|claude|codex> [--model <m>] [--cwd <dir>] [--label <l>]
    # --model 可省略（kinds 默认对齐 herdr-orchestrator）

$HL prompt <name|pane_id> --brief-file <path> | --text <t> | --file <path>
    [--wait-until <s>[,<s>]] [--timeout-ms <n>] [--settle-ms <n>] [--force-paste]
    [--submission-id <id>] [--receipt-path <path>] [--persist-receipt]
    [--transport-profile official-0.7.5|core-managed-enter] [--kind <kind>]
    # 大内容用 --brief-file（短指针）；--file 仍是整段 paste（≠指针）
    # 成功 receipt.transport_phase=lifecycle_observed；其余非零但保留 receipt
    # ⛔ 禁止用 raw herdr agent prompt 代替（只填充不提交）

$HL read <name> [--tail <N>]        # 读 agent 对话输出
$HL wait <name> [--until <s>[,<s>]] [--timeout-ms <n>]   # 轮询到目标状态(默认 idle,done)
$HL list                            # 本工具起过的 agents + herdr 实时状态
$HL kill <name> | --all             # 关 tab 收资源,清台账
$HL scene <scene.json>              # 声明式批量编排:spawn→prompt→collect
```

库调用（voice-agent 叫醒等）：`const { submitPrompt } = require('…/herdr-live/src/live')`，见 README「库 API」。

## 必须知道的坑(否则会踩)

- **禁止只用 herdr agent prompt 当投喂**：0.7.5 下那只是填充；必须走 herdr-live
  `prompt`/`submitPrompt`（版本 profile + per-target lock + receipt）。
- **大 prompt 用短指针**:说明书落盘后 `--brief-file`;不要整段 paste 多 KB 进输入框
  （软上限 ~2KB）。`--file` ≠ `--brief-file`。
- **只按 receipt 相位决策**：已有 working/done/blocked baseline 不证明新 prompt；只接受
  `lifecycle_observed`。只有 `not_sent` 可重试；`ambiguous` 必须停止投递并由上层关闭旧
  Worker 后重派。
- **prompt 提交竞态**：0.7.5 的 settle 是 transport 步骤，不是成功证据；大内容优先
  brief-file，别靠把 `--settle-ms` 调到很大。
- **合作锁边界**：lock 只串行 wrapper callers，不覆盖人手/raw Herdr 输入；同一 target
  不得混用两种路径。
- **read 不是权威源**:回滚窗口有限、长输出会滚掉。需要可靠回收产物时,让 agent **写文件**
  (或写到 Bus/外部 transcript),再去读文件,不要单靠 `read` 的终端输出。
- **model slug**:缺省用 kinds 默认;覆盖前自校验(claude slug ≠ cursor slug)。

## 典型场景(何时想起用它)

见 `~/charlie/herdr-live/scenarios.md`。速记五类:①双端协商/对齐 ②多方案并行生成择优
③群体评审/红蓝对练 ④批量同构任务 ⑤人在场的交互式探查。每类都附了"该用它而不是 X"的边界。
投喂一律走 `prompt`/`submitPrompt`，不要抄底层 `herdr agent prompt`。

## 用完收资源

编排结束务必 `kill --all` 回收 tab;关闭失败会保留台账条目以便重试,可再次 `kill --all`。
`list` 可查当前起过的 agent 与其 tab_id(供人切入某个 pane 时用)。

## 验收(改工具后)

```bash
npm run selftest                      # L0
node test/live-happy-path.js          # L1 单端
node test/l2-dual-cursor-brief.js     # L2 双 cursor + brief-file
```
