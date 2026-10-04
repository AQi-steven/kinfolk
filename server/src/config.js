// server/src/config.js
// 读取/写入设置（LLM 配置），env 优先于 settings 表
// 2026-08-23 新增：支持腾讯云 SecretId/SecretKey（长期凭证，读 CSV 文件），
// 解决 OpenAI 兼容 API Key 短期过期失效问题。
const fs = require('fs');
const path = require('path');
const db = require('./db');

// getLLMConfig 被每个请求调用；结果只依赖 env 与 settings 表，缓存避免每次重读 CSV
let _configCache = null;

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value || '');
  _configCache = null; // 失效缓存
}

function parseSecretKeyFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0] || '';
    const data = lines[1] || '';
    const cols = header.split(',').map((c) => c.trim().replace(/^\uFEFF/, ''));
    const vals = data.split(',').map((c) => c.trim());
    // 优先按列名匹配；列名缺失/为空时回退到位置索引（SecretId=0, SecretKey=1, ApiKey=2）
    const idx = (name) => {
      const i = cols.findIndex((c) => c.toLowerCase() === name.toLowerCase());
      return i >= 0 ? i : -1;
    };
    let secretId = vals[idx('SecretId')] || vals[0] || '';
    let secretKey = vals[idx('SecretKey')] || vals[1] || '';
    let apiKey = vals[idx('ApiKey')] || vals[2] || '';
    if (secretId && secretKey) return { secretId, secretKey, apiKey, filePath };
    if (apiKey) return { secretId: '', secretKey: '', apiKey, filePath };
  } catch (e) {
    console.error('[config] 读取 SecretKey.csv 失败:', e.message);
  }
  return null;
}

function getLLMConfig() {
  if (_configCache) return _configCache;
  const envBase = process.env.LLM_BASE_URL || '';
  const envKey = process.env.LLM_API_KEY || '';
  const envModel = process.env.LLM_MODEL || '';
  const envSecretFile = process.env.LLM_SECRET_KEY_FILE || '';

  // 优先读取本地凭证文件：D:\clawwork\SecretKey.csv（或 env 指定路径）
  // 文件格式：SecretId,SecretKey,ApiKey
  //   - ApiKey 列：TokenHub / OpenAI 兼容 API Key（长期有效，推荐）
  //   - SecretId/SecretKey：腾讯云原生凭证（旧混元 native API 已下线，目前保留兼容）
  const secretFile = envSecretFile || path.join(process.cwd(), 'SecretKey.csv');
  const secretCreds = parseSecretKeyFile(secretFile);

  // 1) 新版 TokenHub OpenAI 兼容（ApiKey 列）
  // 2026-09-13 修复：原先仅在 CSV 的 ApiKey 非空时进入本分支，导致 settings 表里的
  // llm_api_key 一旦写好就永远不生效（被本分支短路，落不到下面的分支 3）。
  // 现改为「CSV 的 ApiKey 优先，缺省时回退 settings 表」，配置链完整且不改变现有行为
  // （当前 CSV 有 ApiKey，仍走原路径）。
  const dbApiKey = getSetting('llm_api_key');
  const openaiKey = (secretCreds && secretCreds.apiKey) || dbApiKey;
  if (openaiKey) {
    const fromCsv = !!(secretCreds && secretCreds.apiKey);
    const cfg = {
      provider: 'openai',
      baseUrl: envBase || getSetting('llm_base_url') || 'https://llm-gateway.example.com/v1',
      apiKey: openaiKey,
      secretId: (secretCreds && secretCreds.secretId) || '',
      secretKey: (secretCreds && secretCreds.secretKey) || '',
      secretFile: (secretCreds && secretCreds.filePath) || '',
      // 默认模型必须是 TokenHub 真实存在的服务 ID。
      // 2026-09-13 实测：hunyuan-pro / hunyuan-lite 均 400 code 400004（服务不存在）；
      // hy3 / glm-5.3 / kimi-k3 等可用。此处兜底避免 env 缺失时退化成"每次抽取都失败"。
      model: envModel || getSetting('llm_model') || 'hy3',
      demoMode: false,
      source: fromCsv ? (envSecretFile ? 'env-file' : 'file') : 'db',
    };
    return (_configCache = cfg);
  }

  // 2) 腾讯云原生混元（SecretId/SecretKey）—— 旧 native API 已下线，保留分支供后续恢复
  if (secretCreds && secretCreds.secretId && secretCreds.secretKey) {
    const cfg = {
      provider: 'tencent-native',
      baseUrl: '',
      apiKey: '',
      secretId: secretCreds.secretId,
      secretKey: secretCreds.secretKey,
      secretFile: secretCreds.filePath,
      model: envModel || getSetting('llm_model') || 'hy3',
      demoMode: false,
      source: envSecretFile ? 'env-file' : 'file',
    };
    return (_configCache = cfg);
  }

  // 3) 兼容旧 env/settings 的 OpenAI 兼容接口
  const baseUrl = envBase || getSetting('llm_base_url');
  const apiKey = envKey || getSetting('llm_api_key');
  const model = envModel || getSetting('llm_model');
  // 强制演示模式（部署验证 / key 失效临时降级）：LLM_DEMO=1 或 true
  const forceDemo = process.env.LLM_DEMO === '1' || process.env.LLM_DEMO === 'true';
  const cfg = {
    provider: 'openai',
    baseUrl,
    apiKey,
    secretId: '',
    secretKey: '',
    secretFile: '',
    model,
    demoMode: forceDemo ? true : !apiKey,
    source: envKey ? 'env' : (apiKey ? 'db' : 'none'),
  };
  return (_configCache = cfg);
}

module.exports = { getSetting, setSetting, getLLMConfig };
