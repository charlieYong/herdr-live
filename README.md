# herdr-live

通用多 agent live 编排工具:起 N 个真 harness agent、喂 prompt、读输出/状态。
是 herdr 底层 CLI(`tab create` / `agent start` / `agent prompt` / `agent read` / `tab close`)
的一层薄封装,把易错的底层序列变成语义明确的五个动词。

> 设计动机、边界与落地历程见 [`design.md`](./design.md);典型使用场景见 [`scenarios.md`](./scenarios.md)。
> **中性通用**:只做功能实现、封装与文档,不替调用者设领域约束("中继/不中继消息"
> 是消费者如 agent2agent 的选择,不是本工具的限制)。

---

## ⛔ 投喂红线（必读）

**投喂必须用 `herdr-live prompt` 或库 API `submitPrompt`。**

| 做法 | 实际效果 |
|---|---|
| ✅ `herdr-live prompt …` / `live.submitPrompt({…})` | 版本感知 transport + per-target 锁 + **结构化 fail-closed receipt** |
| ❌ raw `herdr agent prompt` | **只填充输入框、不提交**（0.7.5）；调用方却以为已投喂 |

**Receipt `transport_phase`：** `not_sent`（可重试）→ `prompt_filled` → `enter_sent` → `lifecycle_observed`；任何投递开始后的不确定结果为 `ambiguous`（**禁止自动重发**）。不声称 server 级 queue/write ack。

**版本 profile：** 官方 `herdr 0.7.5` → prompt→settle→Enter；`core-managed-enter` 禁止二次 Enter；unknown fail-closed。

不要用底层五动词拼「假投喂」。pane_id 叫醒场景同样走 `submitPrompt({ target: pane_id, … })`。

---

## 定位边界

- **不替代 herdr-orchestrator**:不做 task 冻结、accept 门禁、证据 digest、reviewer/verifier
  角色链。那是正式验收编排的领域。herdr-live 是**轻量、多并行、无验收门禁的 live 编排**。
- **不发明新状态机**:agent 生命周期状态直接透传 herdr 的 `idle` / `working` / `done` / `blocked`。

## 前置

- 已安装 `herdr` 且在 Herdr pane 内运行(`HERDR_ENV=1`)。
- Node ≥ 18。
- **推荐调用**：把 `bin/herdr-live.js` symlink 到 `~/.local/bin/herdr-live`（该目录通常已在 PATH），直接跑 `herdr-live …`。无 PATH 时用单路径：`HL="$HOME/charlie/herdr-live/bin/herdr-live.js"; $HL …`——**禁止**把 `node` 与脚本路径拼进同一 `$HL` 变量（zsh 不按空格拆词）。

## 五个核心动词

```
herdr-live spawn <name> --kind <cursor|claude|codex> [--model <m>] [--cwd <dir>] [--label <l>]
    # = tab create(拿 pane_id/tab_id)+ agent start(按 kind 拼对 executor flags)
    # --model 可省略：用 kinds.js 与 herdr-orchestrator 对齐的 defaultModel
    # 创建 tab 前先检查 harness binary；Codex 禁用会话内自更新
    # Cursor Workspace Trust 若已出现则按一次 a；spawn 不因 idle/Trust 失败
    # 返回 { name, pane_id, tab_id, kind, model, cwd, state, workspace_trust_accepted }

herdr-live prompt <name|pane_id> --text <t> | --file <path> | --brief-file <path>
    [--wait-until <s>[,<s>]] [--timeout-ms <n>] [--settle-ms <n>] [--force-paste]
    [--confirm-start-ms <n>] [--submission-id <id>] [--receipt-path <path>] [--persist-receipt]
    [--transport-profile official-0.7.5|core-managed-enter] [--kind <kind>]
    # = live.submitPrompt：加锁、按版本执行 transport、输出结构化 receipt
    # target 可为台账名或 pane_id（如 w3:p16；叫醒常有 pane_id、未必在台账）
    # --brief-file：短指针投喂（agent 自己 Read 文件）——大内容首选
    # --file/--text：整段 paste，软上限 ~2KB；超限请改 --brief-file
    # 默认 --confirm-start-ms 15000；填充前若 Workspace Trust 仍在则 not_sent（可重试）
    # 已 working/done/blocked 的 baseline 不能证明新 prompt；须观察本次之后的状态/序号推进
    # 非 lifecycle_observed 会非零退出，但仍尽量在 stdout/receipt-path 保留 receipt
    # ⛔ 不要用 raw herdr agent prompt 代替本命令（只填充、不提交）

herdr-live read <name> [--tail <N>]
    # = agent read,读完整对话回滚窗口(可选只取尾部)

herdr-live wait <name> [--until <s>[,<s>]] [--timeout-ms <n>] [--poll-ms <n>]
    # 轮询 herdr 实时状态到目标态(默认 idle,done),超时报错
    # Workspace Trust 仍在时不把 idle 当到达，窗内自动按一次 a

herdr-live list                 # 本工具起过的 live agents + herdr 实时状态
herdr-live kill <name> | --all [--force]  # 安全回收 tab 与台账
    # 默认只关闭 idle/done；working/blocked/unknown/gone 会保护并要求先检查。
    # 确认无更新、安装、迁移、上传等关键操作后才能显式 --force。
    # 未关闭成功（含 guarded）时非零退出，stdout 仍打印结构化结果。
    # 只有确认关闭成功(或 tab 本就不存在)才删台账条目;关闭失败保留条目,
    # 以便 kill --all 重试回收——避免条目丢失后 tab 残留、资源无法二次回收。

herdr-live doctor [--kind <k>] [--model <m>]
herdr-live doctor --live --kind <cursor|claude|codex> [--model <m>]
    [--timeout-ms <n>] [--cwd <scratch>] [--confirm-start-ms <n>]
    # advisory 诊断（非 promotion 门禁；与 T09 三 harness 证据格式分离）
    # 输出 schema_version=doctor-v1：local_preflight 与 live_probe 分栏
    # 无 --live：只做 PATH/kind/model 预检，零 spawn、零远程/model 调用；
    #           live_probe.status=not_requested（PATH 成功 ≠ live 成功）
    # 有 --live：必须精确 kind（model 可走 kinds 默认）→ 孤立探针名 spawn +
    #           submitPrompt（禁止 raw herdr agent prompt）→ 须同时具备
    #           lifecycle_observed 与派生 marker（DOCTOR_REV:<token 反转>）
    #           marker 须出现在与 baseline **同一 capture tail** 的单调后缀中；
    #           无法证明 baseline 关系时 fail-closed（stale_output_ambiguous）
    #           公开 JSON 仅含 probe_token_digest / expected_marker_digest（sha256），
    #           从不输出原始 token/marker；token_in_output 仍为布尔
    # 有界 timeout；finally 对本探针做 **guarded kill（无 force）**；
    #           working/blocked/unknown 时 cleanup_guarded，留检、从不 auto-force
    # 对外 JSON 消毒：省略 prompt body、脱敏 API key/token/password/probe token、截断长 stderr
    # 失败 error_code（非穷尽）：unsupported_kind|unsupported_model|executable_unavailable|
    #   ambiguous_transport|timeout|lifecycle_without_token|stale_preexisting_token|
    #   stale_output_ambiguous|auth_or_api_failure|cleanup_failed|cleanup_guarded|
    #   live_probe_failed|…；ok=false 时非零退出
```

## `doctor` 输出 schema（摘要）

```json
{
  "schema_version": "doctor-v1",
  "advisory": true,
  "ok": true,
  "mode": "local|live",
  "error_code": null,
  "local_preflight": {
    "ok": true,
    "herdr_env": true,
    "herdr_in_path": true,
    "kind": "cursor",
    "model": "cursor-grok-4.5-high",
    "executables": { "cursor": { "command": "cursor-agent", "in_path": true } },
    "details": []
  },
  "live_probe": {
    "requested": false,
    "ok": null,
    "status": "not_requested|pass|fail|skipped",
    "probe_name": null,
    "probe_token_digest": null,
    "expected_marker_digest": null,
    "token_in_output": false,
    "lifecycle_observed": false,
    "transport_phase": null,
    "cleanup": {
      "attempted": false,
      "ok": true,
      "outcome": "not_needed|closed|already_gone|guarded|failed",
      "details": { "force": false }
    }
  }
}
```

Public JSON never includes raw `probe_token` / `expected_marker` (success or failure);
correlation uses non-reversible `sha256:…` digests. `token_in_output` remains a boolean.
Cleanup `pending` is internal-only and never appears in a completed result; pre-pane
failures use `outcome:"not_needed"`.

示例：

```bash
# 本地预检 only（无远程）
herdr-live doctor --kind cursor

# 真实 model/API 探针（孤立 tmp cwd；不碰业务 root）
herdr-live doctor --live --kind cursor --model cursor-grok-4.5-high --timeout-ms 180000

# Verifier 用 scratch 入口（同样不改仓库）
node test/doctor-live-scratch.js --kind cursor --model cursor-grok-4.5-high
```

## 库 API：`submitPrompt`

CLI 与库共用同一实现（`src/live.js`）。从其他 Node 工程调用：

```js
const { submitPrompt } = require('/home/user_00/charlie/herdr-live/src/live');
// 或：require('herdr-live')（若已 npm link / 本地 path 依赖）

const receipt = await submitPrompt({
  target: 'w3:p16',           // pane_id 或 herdr-live / herdr 名
  text: '短指令',             // 或 file / briefFile
  submissionId: 'task-42:executor-a1:ctrl-1',
  settleMs: 1000,             // 可选；默认按 kind
  confirmStartMs: 15000,
  persistReceipt: true,
});
// 成功：receipt.transport_phase === 'lifecycle_observed'
// 失败会 throw，结构化事实保留在 error.receipt / error.transport_phase：
//   not_sent（唯一可重试相位）或 ambiguous（禁止自动重发）
```

### Receipt 与恢复规则

Receipt 绑定 `submission_id`、prompt SHA-256、exact target、baseline/observed lifecycle、
Herdr version/profile、相位和时间戳。它是 wrapper transport 的审计事实，不是 server
exactly-once acknowledgement，也不证明 Agent 理解或完成任务。

- `not_sent`：首个 transport 调用尚未开始（含 Workspace Trust 未清除）；调用方可做有界重试。
- `prompt_filled` / `enter_sent`：transport 已开始；不能据此重发。
- `lifecycle_observed`：观察到相对 baseline 的新 lifecycle 证据。
- `ambiguous`：transport 后结果不可证明；必须停止自动重发并隔离旧 Worker。先 `read`
  和检查实时状态；确认没有更新、安装、迁移、上传等关键操作后再关闭。不能把
  “关闭旧 Worker”机械地等同于立即 kill。
- missing/malformed receipt 同样 fail-closed。

Per-target lock 按 Herdr socket/session + pane 串行 wrapper-managed 输入。只有 owner PID 已
消失才允许回收 stale lock，并在 `finally` 释放。它不覆盖人手或 raw Herdr 输入。

## 内建知识(把踩过的坑固化进工具)

- **kind→flags + defaultModel**(`src/kinds.js`):cursor/claude/codex 的 executor flags
  与 default_model 对齐 herdr-orchestrator `config.toml`，不让调用者手拼。
  spawn 解析顺序：显式 `--model` > kind 默认 > 报错。
- **版本化 prompt transport**：官方 0.7.5 的 `agent prompt` 只填充输入框，profile
  执行 settle 后显式 Enter；core-managed-enter profile 禁止 wrapper 再发 Enter；未知
  profile fail-closed。explicit-enter 由 profile 决定，不能被 kind 标志压制。
- **baseline-aware 开工确认**：提交前记录 state/`state_change_seq`。已有 working/done/
  blocked 不能证明本次投递；只有之后的序号/状态推进才可进入 `lifecycle_observed`。
  默认观察窗 15s（与 doctor 对齐，可 `--confirm-start-ms` 覆盖）。假 idle 仍不是成功。
- **Workspace Trust**：Cursor `Workspace Trust Required` + `[a]`/`[q]` 在 spawn 后、
  `wait` 等到 idle 前、以及 `prompt` 填充前自动按一次 `a`。这不是通用权限 UI，不并进
  `resolve-attention`。Trust 未清除时 `wait` 不把 idle 当到达；`prompt` 尚未 transport
  则 `not_sent`（可重试），不得把字填进该对话框。
- **大 prompt 用短指针**:整段 paste 软上限 ~2KB。长说明书落盘后用 `--brief-file`
  （工具只发「请 Read 此路径」指针）。**决策续跑**用 `--file` 直贴短文，或
  `--brief-file … --brief-style answer`（禁止默认派工腔）。注意：旧 `--file` 是
  「读文件再整段塞框」，短 resume 正好用这个。
- **read source**:用默认 source(完整对话);`--source recent-unwrapped` 只回状态栏、
  几乎为空(那是 busy 签名检测的小窗口)。回滚窗口有限,超长输出会滚掉——判官应以
  外部权威源(如 Bus transcript)为准,不单靠 read。
- **ID 抽取**(`src/herdr.js` deepId):从 `tab create` 的嵌套 JSON 里稳健抠
  `pane_id`/`tab_id`,应对 herdr 版本间结构漂移。
- **资源清理**:台账(`~/.herdr-live/agents.json`,可用 `HERDR_LIVE_HOME` 覆盖)记录
  起过的 agent；agent start 失败后也保留可检查的台账。`kill` 默认保护非 idle/done
  状态，确认安全后才用 `--force`。Codex profile 禁用 `in_app_updates`，升级须在 agent
  tab 外显式执行，避免关闭 tab 时中断 npm 的 retire→publish 窗口。

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
npm run selftest                      # L0 确定性核:defaultModel、开工确认、brief-file、台账、submitPrompt(pane_id)
npm run test:doctor                   # L0 doctor：local 零远程、live 分类失败码、cleanup fail-closed
node test/live-happy-path.js          # L1 单端真 agent:spawn → echo 到文件 → read → kill
node test/doctor-live-scratch.js --kind cursor   # 真机 doctor --live scratch（可选）
node test/l2-dual-cursor-brief.js     # L2 双端 cursor:无 --model + --brief-file 并行实测
                                      # L1/L2/scratch 需 HERDR_ENV=1;证据落 logs/… 或 stdout JSON
```

## 模型 slug 陷阱

`cursor-agent` 的 slug ≠ `claude` CLI 的 slug。缺省时用 kinds.js 默认
（cursor=`cursor-grok-4.5-high`，claude=`custom-model-a4`，codex=`custom-model-b5-standard`）；
覆盖 `--model` 前请自校验 slug。
