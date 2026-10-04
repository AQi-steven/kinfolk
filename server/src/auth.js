// server/src/auth.js
// 赛博传记 — 认证基础设施（JWT + 密码哈希，纯 Node crypto，零原生依赖）
const crypto = require('crypto');

// JWT 密钥取值链（2026-09-13 加固，按优先级）：
//   1) 环境变量 JWT_SECRET
//   2) 密钥文件 JWT_SECRET_FILE（默认 /path/to/cybio/jwt.secret，64 位 hex，0600 root-only）
//   3) settings 表的 jwt_secret（历史兜底）
//   4) 本次启动内存随机（最后兜底，重启即失效）
// ⚠️ 安全铁律：绝不允许把密钥硬编码进仓库！曾因 ecosystem.config.cjs 写死
//    'cybio-prod-secret-replace-me' 导致任何人可伪造管理员令牌（2026-09-13 发现并修复）。
const fs = require('fs');

function readSecretFile() {
  const p = process.env.JWT_SECRET_FILE || '/path/to/cybio/jwt.secret';
  try {
    if (!fs.existsSync(p)) return null;
    const s = fs.readFileSync(p, 'utf8').trim();
    return s || null;
  } catch (e) {
    console.warn('[auth] 读取密钥文件失败:', e.message);
    return null;
  }
}

let _secret = null;
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const fromFile = readSecretFile();
  if (fromFile) return fromFile;
  try {
    const d = require('./db');
    const row = d.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
    if (row && row.value) return row.value;
    const s = crypto.randomBytes(32).toString('hex');
    d.prepare("INSERT INTO settings(key, value) VALUES('jwt_secret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(s);
    return s;
  } catch (e) {
    // 兜底：本次启动随机（令牌仅本进程有效，重启失效）——仍远优于硬编码常量
    console.warn('[auth] 无法持久化 JWT 密钥，使用临时随机密钥:', e.message);
    return crypto.randomBytes(32).toString('hex');
  }
}
const SECRET = loadSecret();
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 天

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + TOKEN_TTL };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  // 恒定时间比较，避免时序侧信道
  let a, b;
  try { a = Buffer.from(expected); b = Buffer.from(parts[2]); } catch (e) { return null; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch (e) {
    return null;
  }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + h;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const h2 = crypto.scryptSync(pw, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(h2, 'hex'));
  } catch (e) {
    return false;
  }
}

// Express 中间件：校验 Authorization: Bearer <token>
function authMiddleware(req, res, next) {
  const ah = req.headers['authorization'] || '';
  const token = ah.startsWith('Bearer ') ? ah.slice(7) : '';
  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: '未授权，请先登录' });
  req.user = { id: payload.uid, identifier: payload.identifier };
  next();
}

module.exports = { sign, verify, hashPassword, verifyPassword, authMiddleware };
