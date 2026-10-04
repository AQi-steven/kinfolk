// server/src/routes/auth.js
// 赛博传记 — 账号路由：注册 / 登录 / 当前用户
// 真名锚模型：注册填真实姓名，登录后系统用 real_name 匹配/创建本人 person 节点。
// 邀请码机制已废除（2026-08-23 重构：真名=身份锚，关系网自然涌现）。
const express = require('express');
const router = express.Router();
const db = require('../db');
const { sign, hashPassword, verifyPassword, authMiddleware } = require('../auth');

// 密码强度：≥6 位（2026-09-13 放宽）
// 变更原因：前端三处（auth.html 占位符、web/js/auth.js、web/js/claim.js）一直向用户承诺
//   「密码至少 6 位」，而后端却要求「≥8 位且同时含字母和数字」—— 前后端自相矛盾。
//   老人照前端提示填 6 位纯数字 → 前端放行 → 被后端莫名拒绝，且提示与前端说的不一致。
// 受众是 75+ 父母，产品是「50 人内熟人圈，无需短信验证码」，过强口令要求只会把人挡在门外。
// ⚠️ 补偿措施（放宽强度后必须做）：见下方 loginFails —— 账号级连续失败锁定。
//   原 rateLimited 只按 IP 计数，攻击者换 IP 即可绕过，撑不住 6 位纯数字（仅 10^6 空间）的撞库。
function passwordError(pw) {
  if (!pw || typeof pw !== 'string') return '密码不能为空';
  if (pw.length < 6) return '密码至少 6 位';
  if (pw.length > 72) return '密码过长（最多 72 位）';
  return null;
}

// 账号级连续失败锁定（与按 IP 的 rateLimited 互补，不依赖攻击者 IP 是否变化）
// 同一账号 30 分钟内连续失败 8 次 → 锁 15 分钟。成功登录即清零。
const loginFails = new Map(); // identifier -> { count, firstAt, lockedUntil }
const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60 * 1000;
const FAIL_WINDOW_MS = 30 * 60 * 1000;

function acctLockRemainMin(identifier) {
  const s = loginFails.get(identifier);
  if (!s || !s.lockedUntil || s.lockedUntil <= Date.now()) return 0;
  return Math.max(1, Math.ceil((s.lockedUntil - Date.now()) / 60000));
}

function noteLoginFail(identifier) {
  const now = Date.now();
  let s = loginFails.get(identifier);
  if (!s || now - s.firstAt > FAIL_WINDOW_MS) s = { count: 0, firstAt: now, lockedUntil: 0 };
  s.count += 1;
  if (s.count >= LOCK_AFTER) { s.lockedUntil = now + LOCK_MS; s.count = 0; s.firstAt = now; }
  loginFails.set(identifier, s);
}

function clearLoginFail(identifier) { loginFails.delete(identifier); }

// 轻量限速（内存桶，按 IP+路径，防暴力注册/爆破密码）
const rateBuckets = new Map();
function rateLimited(key, limit = 12, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  rateBuckets.set(key, arr);
  return arr.length > limit;
}

// 注册（账号 + 真名；链接可发给任何人：亲属或陌生人）
router.post('/register', (req, res) => {
  const { identifier, id_type = 'phone', password, real_name = '', nickname = '' } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: '缺少账号或密码' });
  if (rateLimited('register:' + (req.ip || 'x'))) {
    return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  }
  if (!/^[0-9]{6,20}$/.test(identifier) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier)) {
    return res.status(400).json({ error: '账号需为手机号或邮箱' });
  }
  const pwErr = passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const exists = db.prepare('SELECT id FROM users WHERE identifier = ?').get(identifier);
  if (exists) return res.status(409).json({ error: '账号已存在，请直接登录' });
  const hash = hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users(identifier, id_type, real_name, password_hash, nickname) VALUES(?, ?, ?, ?, ?)'
  ).run(identifier, id_type, real_name || nickname || '', hash, nickname);
  const uid = info.lastInsertRowid;
  const token = sign({ uid, identifier });
  res.json({ token, user: { id: uid, identifier, real_name: real_name || nickname || '', nickname, id_type } });
});

// 登录
router.post('/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: '缺少账号或密码' });
  if (rateLimited('login:' + (req.ip || 'x'))) {
    return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  }
  // 账号级锁定（见 passwordError 上方注释：放宽口令强度后的补偿措施）
  const lockMin = acctLockRemainMin(identifier);
  if (lockMin) {
    return res.status(429).json({ error: `该账号连续输错次数过多，请 ${lockMin} 分钟后再试` });
  }
  const u = db.prepare('SELECT * FROM users WHERE identifier = ?').get(identifier);
  if (!u || !verifyPassword(password, u.password_hash)) {
    noteLoginFail(identifier);
    return res.status(401).json({ error: '账号或密码错误' });
  }
  clearLoginFail(identifier);
  const token = sign({ uid: u.id, identifier: u.identifier });
  res.json({ token, user: { id: u.id, identifier: u.identifier, real_name: u.real_name, nickname: u.nickname, id_type: u.id_type } });
});

// 当前用户
router.get('/me', authMiddleware, (req, res) => {
  const u = db.prepare(
    'SELECT id, identifier, id_type, real_name, nickname, avatar_url FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: u });
});

// 登录后确保本人 person 节点存在：用 real_name 匹配；无则创建（本人认领）
// 返回本人 person 节点，供前端大树页以本人为中心展开。
router.post('/ensure-self', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  // 先找已认领给本人的节点；若找到的是已合并节点，沿 merged_into 迁移到保留节点
  let self = db.prepare('SELECT * FROM persons WHERE claimed_by_user_id = ? AND status != \'deleted\'').get(u.id);
  if (!self) {
    const dead = db.prepare('SELECT * FROM persons WHERE claimed_by_user_id = ? AND status = \'deleted\' ORDER BY id LIMIT 1').get(u.id);
    if (dead && dead.merged_into) {
      const kept = db.prepare('SELECT * FROM persons WHERE id = ? AND status != \'deleted\'').get(dead.merged_into);
      if (kept) {
        db.prepare('UPDATE persons SET claimed_by_user_id = NULL WHERE id = ?').run(dead.id);
        if (!kept.claimed_by_user_id) {
          db.prepare('UPDATE persons SET claimed_by_user_id = ? WHERE id = ?').run(u.id, kept.id);
        }
        self = db.prepare('SELECT * FROM persons WHERE id = ?').get(kept.id);
      }
    }
  }
  if (!self) {
    // 再按真名锚匹配：real_name 相同，或（P1-8）节点没填 real_name 但 name 与用户真名相同
    // （建谱人手建骨架节点时往往只填 name，不填 real_name → 之前匹配不上会重复建节点）
    // 同时也覆盖「等待加入」节点：访谈中他人提及该亲属时建的 pending_claim 节点，
    // 等本人真正注册（真名一致）时在此自动认领联系起来。
    // 排序：优先认领 pending_claim（他人访谈中提及、来源可追溯）节点，其次按 id 稳定取最早的一个。
    if (u.real_name) {
      self = db.prepare(
        "SELECT * FROM persons WHERE claimed_by_user_id IS NULL AND status != 'deleted' AND (real_name = ? OR (COALESCE(real_name, '') = '' AND name = ?)) " +
        "ORDER BY (status = 'pending_claim') DESC, id LIMIT 1"
      ).get(u.real_name, u.real_name);
      if (self) {
        // 认领即激活：pending_claim/stub → active（前端灰态"待本人自述"随之消失）
        // 同时把「真名锚」补齐（访谈中提到时节点只有 name、无 real_name，
        // 不补的话后续按真名匹配/合并会再次错认），并回填本人昵称。
        // founder 溯源优先保留原建节点人 → 其次"访谈中提及他的那个人"(source_user_id) → 最后才是本人
        db.prepare(
          "UPDATE persons SET claimed_by_user_id = ?, " +
          "founder_user_id = COALESCE(NULLIF(founder_user_id, 0), NULLIF(source_user_id, 0), ?), " +
          "real_name = ?, name = ?, surname = ?, " +
          "nickname = CASE WHEN COALESCE(nickname, '') = '' THEN ? ELSE nickname END, " +
          "status = 'active', updated_at = datetime('now','localtime') WHERE id = ?"
        ).run(u.id, u.id, u.real_name, u.real_name, (u.real_name || '')[0] || '', u.nickname || u.real_name, self.id);
        self = db.prepare('SELECT * FROM persons WHERE id = ?').get(self.id);
      }
    }
    // 仍无 → 创建本人节点（active，本人认领）
    if (!self) {
      const name = u.real_name || u.nickname || ('用户' + u.id);
      const info = db.prepare(
        'INSERT INTO persons(real_name, claimed_by_user_id, founder_user_id, name, surname, gender, generation, status) VALUES(?, ?, ?, ?, ?, ?, 0, \'active\')'
      ).run(u.real_name, u.id, u.id, name, (name || '')[0] || '', u.gender || '');
      self = db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(info.lastInsertRowid));
    }
  }
  res.json({ person: self });
});

module.exports = router;
