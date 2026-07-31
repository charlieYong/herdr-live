# 设计:herdr-live — 通用多 agent live 编排工具

> 把 herdr 底层能力(扣起 N 个真 agent、发 prompt、读输出/状态)封装成**跨项目可复用**的工具。
> 本文记录**设计动机、边界与落地历程**;用法/坑清单见同工程 [`../README.md`](../README.md)。
> 缘起于 agent2agent 的双 harness spike(见其 ADR-0010),但工具本身独立、通用,agent2agent 只是第一个消费者。
> **现状**:已按本设计落地为 Node CLI(五动词 spawn/prompt/read/wait/kill + scene),确定性自测与真 agent happy-path 均通过。

## 1. 为什么要它(问题)

本轮双 harness spike 里,我手工敲了一串 herdr 底层命令:`tab create` → `agent start --kind cursor --pane … -- <flags>` → `agent prompt` → `send-keys enter` → 轮询 `agent read`。这串东西:
- **易错**:pane_id/tab_id 要从 JSON 里抠、prompt 填充后要额外 enter 提交、模型 flag 要按 adapter profile 拼对;
- **不可复用**:下次别的任务想"起 3 个真 agent 各跑一个剧本再收集输出",得重新踩一遍;
- **与编排器不同用途**:herdr-orchestrator 是 accept-gate 单 executor 的正式验收编排;这里要的是**轻量、多并行、无验收门禁的 live 编排**——"起一批真 agent、喂剧本、看它们干活"。

值得抽成一个通用工具:任何"需要人可在场、多个真 harness agent 并行、由脚本编排"的场景都能用(多 agent 对抗、红蓝对练、群体评审、本项目的双端协商)。

## 2. 边界(不做什么)

herdr-live 是**底层通用工具**,刻意保持中性、少限制——只做好功能实现、封装与文档,不替调用者设领域约束。它的边界只有两条:

- **不替代 herdr-orchestrator**:不做 task 冻结、accept 门禁、证据 digest、reviewer/verifier 角色链。那是正式验收编排的领域。
- **不发明新状态机**:agent 生命周期状态直接透传 herdr 的(idle/working/done/blocked)。

> 注意:"不在 agent 之间中继消息"是 **agent2agent 项目**的红线(它的命题要求两 agent 经 Bus 直连),**不是 herdr-live 的限制**。对通用工具而言,中继输出、基于输出编排决策都是调用者的正当用法。工具提供能力,消费者定约束。

## 3. 封装什么(核心 API)

一层薄封装,把易错的底层序列变成语义明确的调用。建议 Node(与 spike 同栈)或薄 shell,提供:

```
herdr-live spawn <name> --kind cursor --model <m> --cwd <dir>
    # = tab create(拿 pane_id)+ agent start(按 kind 拼对 adapter flags)
    # 返回 { name, pane_id, tab_id, session }

herdr-live prompt <name> --text <t> | --file <path>
    # = agent prompt + 自动补 enter 提交(修掉"填充但没提交"的坑)
    # 可选 --wait-until working|done|idle,封装编排器验证过的稳定等待

herdr-live read <name> [--tail N]
    # = agent read,可选只取尾部

herdr-live wait <name> --until <state> [--timeout-ms M]
    # 轮询到目标状态,超时报错

herdr-live list                 # 当前 live agents + 状态
herdr-live kill <name> | --all  # 关 tab / 收资源(封装 tab close)
```

**关键内建知识**(把我踩过的坑固化进工具):
- **kind→flags 映射**:cursor/claude/codex 的 executor flags(`--model {m} --force --trust --add-dir …`)从一份配置读,不让调用者手拼(照搬 herdr config 的 `[agent.<kind>.executor]`)。
- **prompt 提交**:`agent prompt` 后自动 `send-keys enter`——这是本轮发现的必需步骤(多行 prompt 填充后不自动提交)。
- **ID 抽取**:从 `tab create` 的嵌套 JSON 里稳健抠 `pane_id`/`tab_id`(参考 herdr_client.py 的 `deep_id`)。
- **资源清理**:统一 `kill`/`kill --all`,避免 spike 里手工记 tab_id 逐个关。

## 4. 编排层(可选,薄脚本)

在核心 API 之上,提供一个"批量编排"帮手,覆盖常见形态:

```
herdr-live scene <scene.json>
```
`scene.json` 声明:起哪些 agent(name/kind/model/cwd)、各自初始 prompt(或 prompt 文件)、以及编排者要观察的信号(读哪个 agent 的输出 / 轮询什么状态)。工具负责 spawn→prompt→按声明收集;是否中继、如何基于输出决策,由 scene 声明或调用者决定——工具不预设。

本轮双 harness 就是一个 scene:两个 cursor-grok agent、各自接入 prompt、编排者(我)选择观察 Bus 状态而非 agent 互传——这个"不互传"是 agent2agent 消费时的选择,不是工具强加的。

## 5. 与本项目的关系

- agent2agent 的 S2 验收(join 链接、真 agent 行为测)可直接用 herdr-live 起真 agent,不必每次手敲底层命令。
- 但 herdr-live **本身不属于 agent2agent**——它是通用基建,放 `~/charlie/herdr-live`,agent2agent 只是它的第一个消费者。

## 6. 落地建议(不排期)

1. **抽取**:把本轮验证过的命令序列(见本文件 §3 的"内建知识")固化成 spawn/prompt/read/wait/kill 五个动词 + kind→flags 配置。
2. **自测**:起一个 cursor agent、喂一个"echo 到文件"的 prompt、read 到结果、kill——一条 happy path 幂等自测。
3. **补 scene**:再加批量编排帮手,用双 agent scene 验证。
4. 参考实现来源:`~/charlie/herdr-orchestrator/herdr_orchestrator/herdr_client.py`(`create_worker`/`start_agent`/`adapter_arguments`/`confirm_prompt` 是活范例,但要剥掉 task/attempt/accept 相关,只留 live 编排)。

## 7. 已验证的事实(封装依据,来自本轮实操)

- `herdr tab create --cwd <dir> --no-focus --label <l>` → JSON.result.root_pane.{pane_id,tab_id}。
- `herdr agent start <name> --kind cursor --pane <pid> -- --model cursor-grok-4.5-high --force --trust --add-dir <dir>` → 起可写 cursor agent(argv 实测正确)。
- `herdr agent prompt <name> <text>` **只填充不提交**;需随后 `herdr agent send-keys <name> enter` 才执行。
- **填充与 enter 之间有竞态**(herdr-live 落地时实测发现):`agent prompt` 后立刻 `send-keys enter`,enter 可能在填充落定前触发,导致 prompt 滞留输入框不发出(agent 停在 idle)。需在两者之间插入 settle 延时——实测 <1s 偶发滞留、≥1s 稳定提交;封装应默认加 ~1000ms 延时。
- `herdr agent read <name>` 读终端应**用默认 source**;`--source recent-unwrapped` 实测只回状态栏、几乎为空(那是 busy 签名检测的小窗口,不适合读对话)。回滚窗口有限,长输出会滚掉(判官应以外部权威源如 Bus transcript 为准,不单靠 agent read)。
- `herdr tab close <tab_id>` 收资源。
- 模型 slug 合法性:cursor-grok-4.5-high 可用;claude slug 有陷阱(见 herdr config 注释),封装时应校验。
