// server/src/routes/claims.js
// 赛博传记 — 节点认领（全局图模型，挂在 /api/claims 下）
//   POST /api/claims/:token/auto → 【公开】免密一键认领（老人入口，见下）
//   POST /api/claims/:token      → 当前登录用户认领该节点
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { authMiddleware, sign, hashPassword } = require('../auth');

// ===========================================================================
// 【公开路由 —— 必须声明在 router.use(authMiddleware) 之前】
// POST /api/claims/:token/auto —— 免密一键认领
//
// 为什么需要它（2026-09-13 用户定调「父母自己拿手机用，不代录」）：
//   受众含 75+ 父母。让老人"注册一个账号 + 想一个 ≥6 位密码 + 记住它"是真实门槛
//   （而且他们往往连手机号都用不利索）。改为：子女生成一条认领链接发给父母，
//   父母点开 → 系统自动建号 + 绑节点 + 直接登录进入 → 零表单、零密码。
//
// 安全模型（与"一个账号 = 一个本人节点"的既定决策一致）：
//   · 链接里的 token 是 16 字节随机（128 bit），本身就是凭据；
//   · 一个 token 只能认领它绑定的那一个节点，不能用来认领别的节点；
//   2026-09-14 补充第二种链接 kind='login'：**既有账号的免密登录链接**（父母已有账号、
//   却从未设过可用密码时用）。它不建号、不绑节点，只登进签发时绑定的那个账号；
//   签发入口只有运维脚本（部署方内部工具，不在本仓库），不开 HTTP 入口。
//   · 已认领的 token 不失效，而是**幂等重登**——再次打开即以同一账号登录。
//     这一点是刻意的：这类账号从未设过密码，如果链接一次性作废，
//     父母一旦掉登录态（JWT 30 天）就永久进不来，没有任何找回路径。
//     「链接就是老人的钥匙」，链接只私下发在家人微信里。
//   · 自动建号的 identifier 用 token 派生（`elder_<token前12位>@cybio.local`），
//     永不展示给用户，等价于"这个账号只能用这条链接登"。
//   · 建号时把真名锚直接写成节点的真名 —— 顺带修掉老流程"认领页注册不收集真名"
//     导致 users.real_name 被落成昵称（可能是"妈妈"）的问题。
// ===========================================================================
router.post('/:token/auto', (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE token = ?').get(req.params.token);
  if (!inv) return res.status(404).json({ error: '邀请无效' });

  // 已过期
  if (inv.expires_at) {
    const exp = new Date(String(inv.expires_at).replace(' ', 'T'));
    if (!isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
      try { db.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").run(inv.id); } catch (_) {}
      return res.status(410).json({ error: '这条链接已过期，请让家人重新生成一条发给你' });
    }
  }

  // ---- 已认领过 → 幂等重新登录（链接即钥匙）----
  // ⚠️ 只对 id_type='link' 的账号开放这条路径。这是个**必要的安全闸门**：
  //    邀请被消费的方式有两种 —— ① 老人点链接（auto 建 'link' 账号）② 已登录用户走
  //    POST /claims/:token 正常认领（账号是 'phone'/'email'）。若对第②种也放行自动登录，
  //    则"某人自己认领了节点、随后把链接转发给别人"会让对方**直接登成他的账号**。
  //    限定 'link' 后语义变得精确：只有链接自动开的号才认链接。
  if (inv.status === 'claimed' && inv.claimed_by_user_id) {
    const u = db.prepare('SELECT id, identifier, real_name, nickname, id_type FROM users WHERE id = ?').get(inv.claimed_by_user_id);
    // (A) 运维签发的「免密登录链接」（kind='login'）——2026-09-14 新增。
    //     场景：父母这类**已经注册过账号、但从未设过可用密码**的直系亲属。
    //     与下面的 (B) 刻意不同：它不是"认领一个节点"，而是"登进已有的那个账号"。
    //     安全边界：① 签发入口只有服务端脚本（部署方内部工具，无 HTTP 入口）；
    //              ② 登录目标写死在签发时绑定的账号上，调用方无法指定；
    //              ③ 再核一次"节点此刻是否仍由该账号持有"——被改绑则链接立即失效，绝不可能登成别人。
    if (inv.kind === 'login') {
      const node0 = db.prepare('SELECT id, claimed_by_user_id FROM persons WHERE id = ?').get(inv.node_id);
      if (!u || !node0 || node0.claimed_by_user_id !== inv.claimed_by_user_id) {
        return res.status(409).json({ error: '这条链接已失效，请让家人重新生成一条' });
      }
      try {
        const next = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
        db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run(next, inv.id);
      } catch (_) { /* 续期失败不影响登录 */ }
      const token = sign({ uid: u.id, identifier: u.identifier });
      return res.json({ ok: true, reused: true, token, user: u, person_id: inv.node_id });
    }
    // (B) 免密认领链接（kind='claim'，默认）：只放行"链接自动开的号"（id_type='link'）
    if (u && u.id_type === 'link') {
      // 滚动续期：每次用链接登进来就往后延一年。
      // 否则"链接即钥匙"会变成"一年后钥匙自己作废"，而这类账号没有密码可用来找回。
      try {
        const next = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
        db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run(next, inv.id);
      } catch (_) { /* 续期失败不影响登录 */ }
      const token = sign({ uid: u.id, identifier: u.identifier });
      return res.json({ ok: true, reused: true, token, user: u, person_id: inv.node_id });
    }
    return res.status(409).json({
      error: '该节点已被认领',
      claimed: true,
      hint: u && u.id_type !== 'link' ? '这条链接对应的节点已由其他方式认领，请让家人确认。' : undefined,
    });
  }

  const node = db.prepare('SELECT * FROM persons WHERE id = ?').get(inv.node_id);
  if (!node || node.status === 'deleted') return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id) {
    // 常见情形：本人已经自己注册过，ensure-self 按真名把该节点认领了 ——
    // 此时他不是"被他人抢走"，而是"已经有账号了"。给出可操作提示，而不是死胡同。
    return res.status(409).json({
      error: '这个节点已经认领过了',
      claimed: true,
      hint: '如果你是本人，说明你已经注册过账号啦 —— 请改用「我有账号，去登录」进来。',
    });
  }

  // ---- 真名锚：优先用节点的权威真名，其次展示名 ----
  const anchorName = (node.real_name || node.name || '').trim();
  if (!anchorName) return res.status(400).json({ error: '该节点没有姓名，请让家人补全后再发链接' });

  // token 派生账号名（唯一、不展示、不可猜）
  const identifier = 'elder_' + String(inv.token).slice(0, 12) + '@cybio.local';
  // 随机口令，用户永不可见也永不需要使用；仅为满足 users.password_hash 非空
  const randomPw = crypto.randomBytes(24).toString('hex');

  let uid = inv.claimed_by_user_id;
  try {
    db.transaction(() => {
      if (!uid) {
        // 复用同 identifier 的历史账号（防止重复建号）
        const exist = db.prepare('SELECT id FROM users WHERE identifier = ?').get(identifier);
        if (exist) {
          uid = exist.id;
        } else {
          const info = db.prepare(
            'INSERT INTO users(identifier, id_type, real_name, password_hash, nickname) VALUES(?, ?, ?, ?, ?)'
          ).run(identifier, 'link', anchorName, hashPassword(randomPw), node.nickname || anchorName);
          uid = Number(info.lastInsertRowid);
        }
      }
      db.prepare(
        "UPDATE persons SET claimed_by_user_id = ?, " +
        "founder_user_id = COALESCE(NULLIF(founder_user_id, 0), NULLIF(source_user_id, 0), ?), " +
        "real_name = ?, name = ?, surname = ?, " +
        "nickname = CASE WHEN COALESCE(nickname, '') = '' THEN ? ELSE nickname END, " +
        "status = 'active', updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(uid, inv.created_by || uid, anchorName, anchorName, anchorName[0] || '', anchorName, node.id);
      db.prepare("UPDATE invitations SET status = 'claimed', claimed_by_user_id = ? WHERE id = ?").run(uid, inv.id);
    })();
  } catch (e) {
    console.error('[claims/auto] 免密认领失败:', e.message);
    return res.status(500).json({ error: '认领失败，请稍后重试' });
  }

  const u = db.prepare('SELECT id, identifier, real_name, nickname, id_type FROM users WHERE id = ?').get(uid);
  const token = sign({ uid: u.id, identifier: u.identifier });
  res.json({ ok: true, reused: false, token, user: u, person_id: node.id });
});

// ===== 以下均需登录 =====
router.use(authMiddleware);

router.post('/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE token = ?').get(req.params.token);
  if (!inv) return res.status(404).json({ error: '邀请无效' });
  if (inv.status !== 'pending') return res.status(409).json({ error: '该邀请已使用或过期' });
  const node = db.prepare('SELECT id, name, claimed_by_user_id FROM persons WHERE id = ?').get(inv.node_id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (node.claimed_by_user_id) return res.status(409).json({ error: '该节点已被他人认领' });
  // 一个账号只认领一个本人节点：已有节点则拒绝（先在旧节点上解除绑定或联系建谱人）
  const existing = db.prepare("SELECT id FROM persons WHERE claimed_by_user_id = ? AND status != 'deleted'").get(req.user.id);
  if (existing) return res.status(409).json({ error: '你的账号已绑定了其他节点，不能重复认领' });

  db.transaction(() => {
    db.prepare("UPDATE persons SET claimed_by_user_id = ?, status = 'active', updated_at = datetime('now','localtime') WHERE id = ?")
      .run(req.user.id, node.id);
    db.prepare("UPDATE invitations SET status = 'claimed', claimed_by_user_id = ? WHERE id = ?").run(req.user.id, inv.id);
  })();

  res.json({ ok: true, person_id: node.id });
});

module.exports = router;
