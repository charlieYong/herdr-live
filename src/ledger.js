'use strict';

// 轻量 live agent 台账：记录本工具起过的 agent（name→pane_id/tab_id/kind/model/cwd），
// 让 spawn / kill / list 能跨 CLI 调用互相找到对方的资源，避免 spike 里手工记 tab_id。
// 台账是"我们起的 agent"的记录，不是 herdr 的权威状态——状态永远以 herdr 实时查询为准。

const fs = require('fs');
const os = require('os');
const path = require('path');

const LEDGER_DIR = process.env.HERDR_LIVE_HOME || path.join(os.homedir(), '.herdr-live');
const LEDGER_PATH = path.join(LEDGER_DIR, 'agents.json');

function load() {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && data.agents ? data : { agents: {} };
  } catch (e) {
    return { agents: {} };
  }
}

function save(data) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(data, null, 2));
}

function put(name, entry) {
  const data = load();
  data.agents[name] = { name, ...entry };
  save(data);
  return data.agents[name];
}

function get(name) {
  return load().agents[name] || null;
}

function remove(name) {
  const data = load();
  delete data.agents[name];
  save(data);
}

function all() {
  return Object.values(load().agents);
}

module.exports = { put, get, remove, all, LEDGER_PATH };
