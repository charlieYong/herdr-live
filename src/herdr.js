'use strict';

// 对 herdr 底层 CLI 的最小封装：执行命令、解析 JSON、稳健抠 ID。
// 参考实现来源：~/charlie/herdr-orchestrator/herdr_orchestrator/herdr_client.py
// （create_worker/start_agent/adapter_arguments/confirm_prompt），但剥掉 task/attempt/accept。

const { spawnSync } = require('child_process');

class HerdrError extends Error {}

// 执行一条 herdr 命令。parseJson=true 时把 stdout 解析成对象。
function herdr(args, { parseJson = false } = {}) {
  const proc = spawnSync('herdr', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (proc.error) {
    throw new HerdrError(`无法执行 herdr：${proc.error.message}`);
  }
  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || '无输出').trim();
    throw new HerdrError(`herdr 命令失败（${proc.status}）：herdr ${args.join(' ')}\n${detail}`);
  }
  const out = (proc.stdout || '').trim();
  if (!parseJson) return out;
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new HerdrError(`herdr 返回的不是 JSON：${out.slice(0, 500)}`);
  }
}

// herdr 的 JSON 响应可能是 { result: {...} } 包一层，也可能直接是负载。
function result(data) {
  if (data && typeof data === 'object' && data.result && typeof data.result === 'object') {
    return data.result;
  }
  return data;
}

// 从任意嵌套 JSON 里稳健抠出第一个匹配 key 的字符串值。
// 照搬 herdr_client.py 的 deep_id：应对 herdr 版本间的结构漂移。
function deepId(value, keys) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of keys) {
      const cand = value[key];
      if (typeof cand === 'string' && cand) return cand;
      if (cand && typeof cand === 'object') {
        const nested = cand.value || cand.id;
        if (typeof nested === 'string' && nested) return nested;
      }
    }
    for (const child of Object.values(value)) {
      const found = deepId(child, keys);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = deepId(child, keys);
      if (found) return found;
    }
  }
  return null;
}

function unwrap(value) {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && 'value' in value) {
    return value.value;
  }
  return value;
}

// 取所有 live agent 记录（herdr agent list → result.agents[]）。
function agentRecords() {
  const data = result(herdr(['agent', 'list'], { parseJson: true }));
  if (Array.isArray(data)) return data.filter((x) => x && typeof x === 'object');
  if (data && typeof data === 'object') {
    for (const key of ['agents', 'items', 'data']) {
      if (Array.isArray(data[key])) return data[key].filter((x) => x && typeof x === 'object');
    }
  }
  throw new HerdrError('无法识别 herdr agent list 输出');
}

function agentRecord(name) {
  try {
    const data = result(herdr(['agent', 'get', name], { parseJson: true }));
    if (data && typeof data === 'object') {
      const nested = data.agent;
      // 部分版本 agent 字段是个字符串名，不是记录对象——那种情况回退到 list。
      if (nested && typeof nested === 'object') return nested;
      if (data.agent_status || data.state || data.pane_id) return data;
    }
  } catch (e) {
    // 落到 list 兜底
  }
  for (const rec of agentRecords()) {
    if (unwrap(rec.name || rec.agent || rec.agent_name) === name) return rec;
  }
  throw new HerdrError(`herdr 中找不到 agent：${name}`);
}

function agentState(record) {
  return String(unwrap(record.agent_status || record.state || 'unknown')).toLowerCase();
}

module.exports = {
  HerdrError,
  herdr,
  result,
  deepId,
  unwrap,
  agentRecords,
  agentRecord,
  agentState,
};
