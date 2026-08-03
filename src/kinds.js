'use strict';

// kind→flags 映射：把"起一个可写 live agent"的 executor flags 固化进工具，
// 不让调用者手拼。照搬 herdr-orchestrator config.toml 的 [agent.<kind>.executor]，
// 以及同文件的 default_model（D052）。herdr-live 是中性通用工具、无角色链，
// 每个 kind 只保留一个 live profile（等价 executor：可写、可 add-dir）。
//
// flags 模板变量：{model}、{cwd}。start 时按 kind 填充。

const KINDS = {
  cursor: {
    // 与 herdr-orchestrator/config.toml [agent.cursor].default_model 对齐
    defaultModel: 'cursor-grok-4.5-high',
    // herdr agent start <name> --kind cursor --pane <pid> -- --model <m> --force --trust --add-dir <cwd>
    flags: ['--model', '{model}', '--force', '--trust', '--add-dir', '{cwd}'],
    // prompt 后是否需要补一次 enter 提交（本轮实测：cursor 需要）。
    submitNeedsEnter: true,
    // 填充→enter 之间的默认 settle（毫秒）。只作兜底；大内容应走 --brief-file。
    defaultSettleMs: 1000,
  },
  claude: {
    defaultModel: 'custom-model-a4',
    // claude 需要 session-id；herdr-live 不管理 session 生命周期，交给 herdr 自行生成时
    // 用 --permission-mode auto 降低权限交互（非 OS 沙箱）。
    // 注意：claude model slug 有陷阱（cursor-agent 的 slug ≠ claude CLI 的 slug），调用者需自校验。
    flags: ['--model', '{model}', '--permission-mode', 'auto', '--add-dir', '{cwd}'],
    submitNeedsEnter: true,
    defaultSettleMs: 1000,
  },
  codex: {
    defaultModel: 'custom-model-b5-standard',
    flags: ['-m', '{model}', '-s', 'workspace-write', '-a', 'on-request', '--add-dir', '{cwd}'],
    submitNeedsEnter: true,
    // codex 多行填充偶发比 cursor/claude 慢；默认略长，仍建议大 brief 用 --brief-file。
    defaultSettleMs: 2000,
  },
};

/** 整段 paste 进输入框的软上限（字节）。超过请改 --brief-file。 */
const PASTE_SOFT_LIMIT_BYTES = 2048;

function validateModel(model) {
  if (!model || model.startsWith('-') || /\s/.test(model)) {
    throw new Error(`model 必须是非空、不以 '-' 开头、无空白的单个标识：${JSON.stringify(model)}`);
  }
}

/**
 * 解析最终 model：显式 --model > kind.defaultModel > 报错。
 * @param {string} kind
 * @param {string|undefined|null} model
 * @returns {string}
 */
function resolveModel(kind, model) {
  const profile = KINDS[kind];
  if (!profile) {
    throw new Error(`未配置的 agent kind：${kind}（支持：${Object.keys(KINDS).join(', ')}）`);
  }
  const resolved = model != null && String(model).length > 0 ? String(model) : profile.defaultModel;
  if (!resolved) {
    const hint = Object.entries(KINDS)
      .map(([k, p]) => `${k}→${p.defaultModel || '(无默认)'}`)
      .join(', ');
    throw new Error(`spawn 需要 --model（kind=${kind} 无 defaultModel）。各 kind 默认：${hint}`);
  }
  validateModel(resolved);
  return resolved;
}

function defaultSettleMs(kind) {
  const profile = KINDS[kind];
  return profile && profile.defaultSettleMs != null ? profile.defaultSettleMs : 1000;
}

// 生成某 kind 起 agent 时的 executor flags（已填充 model/cwd）。
function adapterFlags(kind, { model, cwd }) {
  const profile = KINDS[kind];
  if (!profile) {
    throw new Error(`未配置的 agent kind：${kind}（支持：${Object.keys(KINDS).join(', ')}）`);
  }
  validateModel(model);
  const values = { model, cwd };
  return profile.flags.map((f) =>
    f.replace(/\{(\w+)\}/g, (_, k) => {
      if (!(k in values)) throw new Error(`flags 模板引用了未知变量 {${k}}`);
      return values[k];
    })
  );
}

function submitNeedsEnter(kind) {
  const profile = KINDS[kind];
  return profile ? profile.submitNeedsEnter !== false : true;
}

/**
 * 把落盘的长说明书变成短指针（方案 A）：输入框只发指针，正文由 agent 自己 Read。
 * @param {string} absPath
 * @param {{ cwd?: string }} [opts]
 */
function buildBriefPointer(absPath, opts = {}) {
  const lines = [
    '请完整阅读并严格按此文件执行（不要摘要、不要跳过步骤）：',
    String(absPath),
  ];
  if (opts.cwd) lines.push(`工作目录：${opts.cwd}`);
  lines.push('读完后立刻按文件中的步骤开工。');
  return lines.join('\n');
}

module.exports = {
  KINDS,
  PASTE_SOFT_LIMIT_BYTES,
  adapterFlags,
  submitNeedsEnter,
  validateModel,
  resolveModel,
  defaultSettleMs,
  buildBriefPointer,
};
