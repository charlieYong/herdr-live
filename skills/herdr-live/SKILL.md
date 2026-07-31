---
name: herdr-live
description: "在 Herdr 里轻量地起多个真交互式 agent(cursor/claude/codex)并行跑、喂 prompt、读输出/状态的 live 编排。当你需要多 agent 对练/双端协商/多方案并行/批量同构任务,且不需要验收门禁与证据链时使用。不要用于:只想后台跑命令(用 herdr 本体)、需要正式验收编排(用 herdr-supervisor)、headless 无人值守(用 claude -p/SDK)。要求 HERDR_ENV=1。"
---

# herdr-live

通用多 agent live 编排工具:起 N 个真 harness agent、喂 prompt、读输出/状态。是 herdr
底层 CLI 的一层薄封装,把易错的底层序列变成语义明确的五个动词。工具在独立工程
`~/charlie/herdr-live`;完整用法见其 `README.md`,设计见 `design.md`,典型场景见 `scenarios.md`。

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

## 五个动词(调用一律用绝对路径,不依赖 PATH)

```bash
HL="node ~/charlie/herdr-live/bin/herdr-live.js"

$HL spawn <name> --kind <cursor|claude|codex> --model <m> [--cwd <dir>] [--label <l>]
    # 起一个 live agent(tab create 拿 pane_id + agent start 按 kind 拼 executor flags)

$HL prompt <name> --text <t> | --file <path> [--wait-until <s>[,<s>]] [--timeout-ms <n>] [--settle-ms <n>]
    # 发 prompt 并自动提交(内建填充→settle→enter)

$HL read <name> [--tail <N>]        # 读 agent 对话输出
$HL wait <name> [--until <s>[,<s>]] [--timeout-ms <n>]   # 轮询到目标状态(默认 idle,done)
$HL list                            # 本工具起过的 agents + herdr 实时状态
$HL kill <name> | --all             # 关 tab 收资源,清台账
$HL scene <scene.json>              # 声明式批量编排:spawn→prompt→collect
```

## 必须知道的坑(否则会踩)

- **prompt 提交竞态**:`prompt` 内部在填充与 enter 之间插了 ~1s settle 延时才稳定提交;
  若自定义 `--settle-ms`,别设太小(<1s 偶发滞留、prompt 发不出)。
- **read 不是权威源**:回滚窗口有限、长输出会滚掉。需要可靠回收产物时,让 agent **写文件**
  (或写到 Bus/外部 transcript),再去读文件,不要单靠 `read` 的终端输出。
- **model slug**:cursor 用 `cursor-grok-4.5-high` 之类;claude 的 slug 与 cursor 不同,用前自校验。

## 典型场景(何时想起用它)

见 `~/charlie/herdr-live/scenarios.md`。速记五类:①双端协商/对齐 ②多方案并行生成择优
③群体评审/红蓝对练 ④批量同构任务 ⑤人在场的交互式探查。每类都附了"该用它而不是 X"的边界。

## 用完收资源

编排结束务必 `kill --all` 回收 tab;关闭失败会保留台账条目以便重试,可再次 `kill --all`。
`list` 可查当前起过的 agent 与其 tab_id(供人切入某个 pane 时用)。
