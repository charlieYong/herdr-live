'use strict';

// kind→flags 映射：把"起一个可写 live agent"的 executor flags 固化进工具，
// 不让调用者手拼。照搬 herdr config 的 [agent.<kind>.executor]，但 herdr-live 是
// 中性通用工具、无角色链，因此每个 kind 只保留一个 live profile（等价于 executor：
// 可写、可 add-dir）。需要只读/受限 profile 的领域约束由消费者自己加，不在此预设。
//
// flags 模板变量：{model}、{cwd}。start 时按 kind 填充。

const KINDS = {
  cursor: {
    // herdr agent start <name> --kind cursor --pane <pid> -- --model <m> --force --trust --add-dir <cwd>
    flags: ['--model', '{model}', '--force', '--trust', '--add-dir', '{cwd}'],
    // prompt 后是否需要补一次 enter 提交（本轮实测：cursor 需要）。
    submitNeedsEnter: true,
  },
  claude: {
    // claude 需要 session-id；herdr-live 不管理 session 生命周期，交给 herdr 自行生成时
    // 用 --permission-mode auto 降低权限交互（非 OS 沙箱）。
    // 注意：claude model slug 有陷阱（cursor-agent 的 slug ≠ claude CLI 的 slug），调用者需自校验。
    flags: ['--model', '{model}', '--permission-mode', 'auto', '--add-dir', '{cwd}'],
    submitNeedsEnter: true,
  },
  codex: {
    flags: ['-m', '{model}', '-s', 'workspace-write', '-a', 'on-request', '--add-dir', '{cwd}'],
    submitNeedsEnter: true,
  },
};

function validateModel(model) {
  if (!model || model.startsWith('-') || /\s/.test(model)) {
    throw new Error(`model 必须是非空、不以 '-' 开头、无空白的单个标识：${JSON.stringify(model)}`);
  }
}

// 生成某 kind 起 agent 时的 executor flags（已填充 model/cwd）。
function adapterFlags(kind, { model, cwd }) {
  const profile = KINDS[kind];
  if (!profile) {
    throw new Error(`未配置的 agent kind：${kind}（支持：${Object.keys(KINDS).join(', ')}）`);
  }
  validateModel(model);
  const values = { model, cwd };
  return profile.flags.map((f) => f.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`flags 模板引用了未知变量 {${k}}`);
    return values[k];
  }));
}

function submitNeedsEnter(kind) {
  const profile = KINDS[kind];
  return profile ? profile.submitNeedsEnter !== false : true;
}

module.exports = { KINDS, adapterFlags, submitNeedsEnter, validateModel };
