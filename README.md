# herdr-live

通用多 agent live 编排工具:起 N 个真 harness agent、喂 prompt、读输出/状态。
是 herdr 底层 CLI(`tab create` / `agent start` / `agent prompt` / `agent read` / `tab close`)
的一层薄封装,把易错的底层序列变成语义明确的五个动词。

> 设计动机、边界与落地历程见 [`design.md`](./design.md);典型使用场景见 [`scenarios.md`](./scenarios.md)。
> **中性通用**:只做功能实现、封装与文档,不替调用者设领域约束("中继/不中继消息"
> 是消费者如 agent2agent 的选择,不是本工具的限制)。

## 定位边界

- **不替代 herdr-orchestrator**:不做 task 冻结、accept 门禁、证据 digest、reviewer/verifier
  角色链。那是正式验收编排的领域。herdr-live 是**轻量、多并行、无验收门禁的 live 编排**。
- **不发明新状态机**:agent 生命周期状态直接透传 herdr 的 `idle` / `working` / `done` / `blocked`。

## 前置

- 已安装 `herdr` 且在 Herdr pane 内运行(`HERDR_ENV=1`)。
- Node ≥ 18。

## 五个核心动词

```
herdr-live spawn <name> --kind <cursor|claude|codex> [--model <m>] [--cwd <dir>] [--label <l>]
    # = tab create(拿 pane_id/tab_id)+ agent start(按 kind 拼对 executor flags)
    # --model 可省略：用 kinds.js 与 herdr-orchestrator 对齐的 defaultModel
    # 返回 { name, pane_id, tab_id, kind, model, cwd, state }

herdr-live prompt <name> --text <t> | --file <path> | --brief-file <path>
    [--wait-until <s>[,<s>]] [--timeout-ms <n>] [--settle-ms <n>] [--force-paste]
    # = agent prompt + settle + send-keys enter，再短窗确认开工
    # --brief-file：短指针投喂（agent 自己 Read 文件）——大内容首选
    # --file/--text：整段 paste，软上限 ~2KB；超限请改 --brief-file
    # 成功前必须见到 working|done|blocked；仍 idle 视为未发出并报错

herdr-live read <name> [--tail <N>]
    # = agent read,读完整对话回滚窗口(可选只取尾部)

herdr-live wait <name> [--until <s>[,<s>]] [--timeout-ms <n>] [--poll-ms <n>]
    # 轮询 herdr 实时状态到目标态(默认 idle,done),超时报错

herdr-live list                 # 本工具起过的 live agents + herdr 实时状态
herdr-live kill <name> | --all  # 关 tab 收资源,清台账
    # 只有确认关闭成功(或 tab 本就不存在)才删台账条目;关闭失败保留条目,
    # 以便 kill --all 重试回收——避免条目丢失后 tab 残留、资源无法二次回收。
```

## 内建知识(把踩过的坑固化进工具)

- **kind→flags + defaultModel**(`src/kinds.js`):cursor/claude/codex 的 executor flags
  与 default_model 对齐 herdr-orchestrator `config.toml`，不让调用者手拼。
  spawn 解析顺序：显式 `--model` > kind 默认 > 报错。
- **prompt 提交竞态 + 开工确认**:`agent prompt` 只填充输入框、不提交;需随后
  `send-keys enter`。填充与 enter 之间有竞态——故默认 settle（cursor/claude 1s，
  codex 2s）只作兜底。更关键：短窗内必须见到 `working|done|blocked`，否则抛错；
  **禁止**返回 `{submitted:true, state:idle}` 假成功。
- **大 prompt 用短指针**:整段 paste 软上限 ~2KB。长说明书落盘后用 `--brief-file`
  （工具只发「请 Read 此路径」指针）。注意：旧 `--file` 仍是「读文件再整段塞框」，
  不是指针投喂。
- **read source**:用默认 source(完整对话);`--source recent-unwrapped` 只回状态栏、
  几乎为空(那是 busy 签名检测的小窗口)。回滚窗口有限,超长输出会滚掉——判官应以
  外部权威源(如 Bus transcript)为准,不单靠 read。
- **ID 抽取**(`src/herdr.js` deepId):从 `tab create` 的嵌套 JSON 里稳健抠
  `pane_id`/`tab_id`,应对 herdr 版本间结构漂移。
- **资源清理**:台账(`~/.herdr-live/agents.json`,可用 `HERDR_LIVE_HOME` 覆盖)记录
  起过的 agent,`kill`/`kill --all` 统一收资源,不用手工记 tab_id。

## scene 批量编排(可选)

```
herdr-live scene <scene.json>
```

`scene.json` 声明起哪些 agent、各自初始 prompt、要收集哪些输出。工具负责
spawn→prompt→collect。是否中继、如何基于输出决策由 scene 声明或调用者决定。

```json
{
  "agents": [
    { "name": "a", "kind": "cursor", "cwd": "/path",
      "briefFile": "/path/to/long-brief.md",
      "waitUntil": ["idle", "done"], "timeoutMs": 300000 }
  ],
  "collect": [ { "agent": "a", "tail": 40 } ]
}
```

## 自测 / 验收分层

```
npm run selftest                      # L0 确定性核:defaultModel、开工确认、brief-file、台账
node test/live-happy-path.js          # L1 单端真 agent:spawn → echo 到文件 → read → kill
node test/l2-dual-cursor-brief.js     # L2 双端 cursor:无 --model + --brief-file 并行实测
                                      # L1/L2 需 HERDR_ENV=1;证据落 logs/l2-dual-cursor-brief/
```

## 模型 slug 陷阱

`cursor-agent` 的 slug ≠ `claude` CLI 的 slug。缺省时用 kinds.js 默认
（cursor=`cursor-grok-4.5-high`，claude=`custom-model-a4`，codex=`custom-model-b5-standard`）；
覆盖 `--model` 前请自校验 slug。
