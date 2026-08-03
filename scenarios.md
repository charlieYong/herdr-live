# herdr-live 典型使用场景

> 五个动词(见 [`README.md`](./README.md))告诉你**能做什么**;本文告诉你**什么时候该想起用它**。
> 每个场景附一条"该用 herdr-live 而不是 X"的边界,防止误用。

## 何时用 herdr-live(一句话触发锚)

需要在 Herdr 里**轻量地起多个真 agent 并行跑、喂 prompt、读输出/状态**,且**不需要**验收门禁/证据链时。
起的是**交互式 harness agent**(cursor/claude/codex),不是 headless——因此人可以随时在某个 pane 介入。

## 何时**不**用(边界)

| 你想做的 | 该用 | 为什么不是 herdr-live |
|---|---|---|
| 后台跑一条命令 / 开个终端布局 | `herdr` 本体 | herdr-live 是"起 agent 编排",不是通用终端管理 |
| 正式验收编排(冻结 DoD、accept 门禁、证据链) | `herdr-supervisor`(herdr-orchestrator) | herdr-live **无验收门禁**,只做 live 编排 |
| headless 批处理、无人值守 | `claude -p` / SDK | herdr-live 起的是交互式 harness,定位是"人可在场" |

---

## 场景 1:双端协商 / 对齐

**形态**:起两个真 agent,各自接入**不同项目上下文**(不同 cwd),编排者喂剧本、观察它们向共识收敛。

**编排**:`spawn a`(项目 A)+ `spawn b`(项目 B)→ 各 `prompt` 初始目标 → 轮流 `read` 对方输出、`prompt` 转达或注入引导 → `wait` 到 idle 判断回合结束。

**实证**:agent2agent 的双 harness spike(见 [`design.md`](./design.md) §7)就是这个场景——两个 cursor agent 经 Bus 协商,编排者旁观 transcript。

**边界**:是否在 agent 间中继消息,由编排者决定;herdr-live 不预设(agent2agent 选择"经 Bus 直连、不中继",那是它的红线,不是工具的)。

## 场景 2:多方案并行生成 + 择优

**形态**:同一问题,起 N 个 agent(不同 model,或同 model 不同提示角度)各出一版方案,编排者读回全部输出做比较。

**编排**:`scene.json` 声明 N 个 agent + 各自 prompt + collect → 一次 `scene` 跑完收齐 → 编排者比对 `collected[]`。

**边界**:只要"多个独立视角",不要求谁验收谁——要正式打分/门禁就升级到 herdr-supervisor。

## 场景 3:群体评审 / 红蓝对练

**形态**:一个 agent 产出(方案/代码/论证),另一个 agent 专职挑刺,编排者中继或旁观,多回合对抗。

**编排**:`spawn producer` + `spawn critic` → producer `prompt` 产出 → `read` 取产出 → 作为 critic 的 `prompt` 输入 → 收集反驳 → 回传 producer。回合由编排者控制。

**边界**:这是"live 对练"不是"验收"——critic 的结论不进任何 accept digest。需要有约束力的 reviewer/verifier 角色链时用 herdr-supervisor。

## 场景 4:批量同构任务

**形态**:一组输入,对每个各起一个 agent 跑**同一剧本**,收集结果(如:对 10 个模块各起一个 agent 做同类改造/审查)。

**编排**:声明式 `scene.json`——`agents[]` 每项同构(同 kind/model/prompt 模板,不同 cwd/输入)+ `collect[]` 收全部 → 一次 `scene` 跑完。

**边界**:并发上限受 herdr 资源约束;超长输出会滚出 read 窗口(见坑),关键产物应让 agent 写文件而非只靠 read 回收。

## 场景 5:人在场的交互式探查

**形态**:任务中途需要**真人介入**(签字确认、补充信息、看一眼再决定)。因为 herdr-live 起的是交互式 harness,人可以直接切到那个 pane 操作。

**编排**:`spawn` 后正常 `prompt`;当 agent 进入 blocked(等权限/等输入)或编排者判断需人工时,提示人切到对应 tab(`list` 可查 tab_id)介入,人处理完编排者再 `wait`/继续。

**边界**:herdr-live 不做权限 UI 识别/自动按键(那是 herdr-supervisor 的 resolve-attention 领域);它只负责把 agent 起在人能触达的交互式 pane 里。

---

## 通用注意(跨场景)

- **前置**:必须在 Herdr pane 内(`HERDR_ENV=1`)。
- **大 prompt 用 `--brief-file`**:长说明书落盘后发短指针;不要整段 paste 多 KB
  (`--file` ≠ `--brief-file`)。双端验收见 `node test/l2-dual-cursor-brief.js`。
- **prompt 提交**:settle 只作兜底;成功以开工确认(`working|done|blocked`)为准,不信假 idle。
- **read 不是权威源**:回滚窗口有限、长输出会滚掉。判官/收集应以外部权威源(agent 写出的文件、Bus transcript)为准,不单靠 `read`。
- **收资源**:用完 `kill` / `kill --all`;关闭失败会保留台账条目以便重试回收。
