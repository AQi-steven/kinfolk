// server/src/db.js
// 赛博传记 — 全局关系图模型（node:sqlite，零原生依赖）
// 产品定位（2026-08-23 重新定调）：传记第一性、家谱从访谈线索自然涌现。
// 废除多租户 family_trees / tree_members / invite_code / clan_snapshots / invitations。
// 新人以"真名"作身份锚注册；关系网由每个人访谈抽出的关系边（relationships）自然生长。
// 两棵 ego 树出现"同名 + 同关系角色"候选节点时，触发 merge_proposals（三问题验证）合并。
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.CYBIO_DB || path.join(DATA_DIR, 'cybio.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = OFF;');

const SCHEMA = `
-- 账号（真实姓名作身份锚；链接可发给任何人：亲属或陌生人）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  id_type TEXT DEFAULT 'phone' CHECK (id_type IN ('phone','email','link')),
  real_name TEXT DEFAULT '',          -- 真名锚：注册时填，用于和 persons 对齐
  password_hash TEXT DEFAULT '',
  nickname TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_identifier ON users(identifier);
CREATE INDEX IF NOT EXISTS idx_users_realname ON users(real_name);

-- 人物节点（全局图，不再有 tree_id 维度；真名=身份锚）
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  real_name TEXT DEFAULT '',          -- 真名（与用户 real_name 对齐的核心字段）
  claimed_by_user_id INTEGER,         -- 被本人认领 → 绑定用户；NULL = 仅 stub/他人代录
  founder_user_id INTEGER,            -- 首次建立此节点的人（关系网仲裁参考）
  visibility TEXT DEFAULT 'family' CHECK (visibility IN ('self','family','public')),
  name TEXT NOT NULL,
  gender TEXT DEFAULT '',
  birth_date TEXT DEFAULT '',
  death_date TEXT DEFAULT '',
  birthplace TEXT DEFAULT '',
  residence TEXT DEFAULT '',
  occupation TEXT DEFAULT '',
  education TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  profile_json TEXT DEFAULT '{}',
  surname TEXT DEFAULT '',            -- 姓氏（为空时取 name 首字派生）
  generation INTEGER DEFAULT 0,       -- 世代（相对根，用于大树分层；0=本人，负=上代，正=下代）
  status TEXT DEFAULT 'active' CHECK (status IN ('active','stub','pending_claim','deleted')),
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name);
CREATE INDEX IF NOT EXISTS idx_persons_realname ON persons(real_name);
CREATE INDEX IF NOT EXISTS idx_persons_claim ON persons(claimed_by_user_id);


-- 关系边（全局图；parent=from 是 to 的父母；spouse=夫妻。兄弟姐妹由共享父母派生）
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_person_id INTEGER NOT NULL,
  to_person_id   INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('parent','spouse','sibling','acquaintance')),
  note TEXT DEFAULT '',
  source INTEGER,                     -- 谁访谈抽出的（user_id），便于追溯/去重
  confidence REAL DEFAULT 1.0,        -- 置信度（同名合并时参考）
  status TEXT DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_person_id);
CREATE INDEX IF NOT EXISTS idx_rel_to   ON relationships(to_person_id);

-- 代录/查看他人生平授权请求（B_X：写他人传记需授权；仅补 stub 免授权）
CREATE TABLE IF NOT EXISTS relay_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_user_id INTEGER NOT NULL,  -- 请求代录/查看的人
  target_person_id INTEGER NOT NULL,   -- 目标人物节点
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  reviewed_by INTEGER,                 -- 审批人（目标本人或族长）
  reviewed_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  UNIQUE(requester_user_id, target_person_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_target ON relay_requests(target_person_id);
CREATE INDEX IF NOT EXISTS idx_relay_requester ON relay_requests(requester_user_id);

-- 同名三问题验证提案（阶段3：两棵树出现同名+同关系角色候选 → 系统自动检测 → 双方各答3题）
CREATE TABLE IF NOT EXISTS merge_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_a INTEGER NOT NULL,           -- 候选节点 A
  person_b INTEGER NOT NULL,           -- 候选节点 B（疑似同一人）
  proposed_by INTEGER,                 -- 触发者
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected','expired')),
  questions_a TEXT DEFAULT '[]',       -- 抽取给 A 方回答的 3 题（JSON 数组）
  questions_b TEXT DEFAULT '[]',       -- 抽取给 B 方回答的 3 题
  answers_a TEXT DEFAULT '[]',         -- A 方回答
  answers_b TEXT DEFAULT '[]',         -- B 方回答
  matched INTEGER DEFAULT 0,           -- 答对题数（用于判定）
  reviewed_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_merge_a ON merge_proposals(person_a);

-- 节点认领邀请（全局图模型：无 tree 维度，直接锚定 persons 节点）
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,              -- 待认领的 persons 节点
  token TEXT UNIQUE NOT NULL,
  created_by INTEGER,                    -- 生成邀请的用户
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','claimed','expired')),
  expires_at DATETIME,
  claimed_by_user_id INTEGER,            -- 免密认领时自动建号/绑定的账号（同一链接可再次登录该账号）
  kind TEXT DEFAULT 'claim',             -- 'claim'=认领链接（可自动建号）| 'login'=既有账号的免密登录链接（运维脚本签发）
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_invitations_node ON invitations(node_id);
CREATE INDEX IF NOT EXISTS idx_merge_b ON merge_proposals(person_b);

-- 访谈会话（person_claim=补全自己 / relay=代录他人）
CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  target_person_id INTEGER,
  type TEXT DEFAULT 'person_claim' CHECK (type IN ('person_claim','relay')),
  status TEXT DEFAULT 'active',
  started_at DATETIME DEFAULT (datetime('now','localtime')),
  finished_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_interviews_user ON interviews(user_id);
CREATE INDEX IF NOT EXISTS idx_interviews_target ON interviews(target_person_id);

-- 消息（含回忆录章节卡片 kind='chapter'）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  kind TEXT DEFAULT 'chat' CHECK (kind IN ('chat','chapter','system')),
  chapter_id INTEGER,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_msg_interview ON messages(interview_id);

-- 回忆录章节（AI 阶段性总结沉淀，当事人可设权限）
CREATE TABLE IF NOT EXISTS memoir_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  excerpt TEXT DEFAULT '',
  visibility TEXT DEFAULT 'family' CHECK (visibility IN ('self','family','public')),
  stage TEXT DEFAULT 'life',
  year INTEGER DEFAULT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_person ON memoir_chapters(person_id);

-- 媒体（照片等，按人归属）
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  url TEXT DEFAULT '',
  type TEXT DEFAULT 'photo',
  caption TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_media_person ON media(person_id);

-- 原始录音（原音追溯，2026-10-04）
-- 此前 ASR 识别完即丢弃音频，导致"原音回放"无数据基础。这里留存每段人声，
-- 供章节页回听本人当时到底怎么说的（AI 转写可能有误，真人原音才是准的）。
-- 只存本人/已授权对象的访谈录音，随节点软删，不做云端同步。
CREATE TABLE IF NOT EXISTS audio_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,                 -- 对应的原话消息（沉淀时回写，用于章节聚合）
  interview_id INTEGER,
  person_id INTEGER,
  chapter_id INTEGER,                 -- 沉淀后回写，章节页据此聚合
  file TEXT DEFAULT '',               -- 相对 uploads/ 的文件名
  mime TEXT DEFAULT 'audio/wav',
  duration_ms INTEGER DEFAULT 0,
  size_bytes INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audio_msg ON audio_clips(message_id);
CREATE INDEX IF NOT EXISTS idx_audio_chapter ON audio_clips(chapter_id);

-- 原话订正留痕（2026-10-04 P5）
-- 本人可订正 ASR 听错的原话文字（用户拍板"本人可订正，原音保留"），
-- 但"改过什么"必须永远查得到：订正前的原文存这里，**只增不改不删**。
-- 音频（audio_clips）任何情况下都不改 —— 声音是"真的这么说过"的证据。
CREATE TABLE IF NOT EXISTS corrections_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  old_text TEXT DEFAULT '',
  new_text TEXT DEFAULT '',
  by_user_id INTEGER,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_corr_msg ON corrections_audit(message_id);

-- 家人补充建议（2026-10-04 P5）
-- 闭环：家人写补充 → 本人在回忆录里看到待确认 → 点「采纳」即时入正文。
-- 为什么要有这层：传记主语是讲述者本人，谁有权定稿必须是他。StoryHeir 那种
-- "所有人可写 contribution"的方案适合家族群聊，但会让子女的话直接覆盖父亲的自述。
-- 设计取舍（用户 2026-10-04 拍板）：采纳动作=授权直接生效，本人不再逐条改字；
-- 但**必须由本人点**，绝不自动入正文。原话与原音不在本表管辖（见 messages/audio_clips）。
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,            -- 补充的是谁的传记
  chapter_id INTEGER,                    -- 建议挂到哪一章（可空=整本待办）
  author_user_id INTEGER NOT NULL,       -- 谁写的
  author_name TEXT DEFAULT '',           -- 署名（"妈妈"这种称谓，便于本人辨认）
  content TEXT NOT NULL,                 -- 补充内容
  kind TEXT DEFAULT 'story' CHECK (kind IN ('story','photo','fact')),  -- 故事/照片线索/事实纠正
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','adopted','dismissed')),
  adopted_chapter_id INTEGER,            -- 采纳后落到哪一章
  adopted_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sug_person ON suggestions(person_id, status);
CREATE INDEX IF NOT EXISTS idx_sug_author ON suggestions(author_user_id);

-- 章节正文版本历史（2026-10-04）
-- 为什么要：此前 memoir_chapters.summary 是**直接覆盖**的 —— 用户改一次，
--   AI 写的原文就永久消失，改错了只能凭记忆回退。传记正文是不可再生的资产，
--   必须留痕。
-- 每条记录 = 一次改动前的旧值快照（谁、什么时候、原来长什么样）。
-- 只增不改不删；同一章节超过 MAX_VERSIONS 后由应用层淘汰最旧的。
CREATE TABLE IF NOT EXISTS chapter_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  excerpt TEXT DEFAULT '',
  year INTEGER DEFAULT NULL,
  source TEXT DEFAULT 'edit' CHECK (source IN ('edit','ai_sediment','ai_extend','suggestion','restore')),
  note TEXT DEFAULT '',              -- 改动人/原因，便于"这次是谁改的"可查
  by_user_id INTEGER,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cv_chapter ON chapter_versions(chapter_id, id DESC);

-- 设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

-- 访谈已确认字段（复查确认后写入，后续轮次不再重复弹出复核）
CREATE TABLE IF NOT EXISTS interview_confirmed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  UNIQUE(interview_id, path)
);
CREATE INDEX IF NOT EXISTS idx_conf_interview ON interview_confirmed(interview_id);
`;

db.exec(SCHEMA);

// 幂等迁移（2026-10-04 照片破冰）：media 表原本只能挂 person，照片无法关联到具体章节/访谈，
// 导致"照片 → 章节 → 回忆录"闭环断掉。这里补三个可空关联列，均为 ALTER，已存在则忽略。
(function ensureMediaContextColumns() {
  for (const col of [
    'chapter_id INTEGER DEFAULT NULL',
    'interview_id INTEGER DEFAULT NULL',
    'user_hint TEXT DEFAULT \'\'',   // 用户对这张照片的一句话补充（"这是外婆抱着我"），供 AI 破冰提问
  ]) {
    try { db.prepare(`ALTER TABLE media ADD COLUMN ${col}`).run(); }
    catch (_) { /* 已存在则忽略 */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_media_chapter ON media(chapter_id)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_media_interview ON media(interview_id)'); } catch (_) {}
})();

// 幂等迁移：同一对人物 + 同一关系类型只允许一条 active 边，防重复边（P2 健壮性）
(function ensureRelationshipUnique() {
  try {
    // 先去重：同 (from,to,type) 多条 active 只留最小 id
    db.exec(
      "DELETE FROM relationships WHERE status = 'active' AND id NOT IN (" +
      "SELECT MIN(id) FROM relationships WHERE status = 'active' GROUP BY from_person_id, to_person_id, type)"
    );
  } catch (_) { /* 忽略 */ }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_uniq ON relationships(from_person_id, to_person_id, type) WHERE status = 'active'");
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移：同名合并后，被合并节点指向保留节点（阶段3 merge X 方案）
(function ensureMergedInto() {
  try {
    const cols = db.prepare('PRAGMA table_info(persons)').all().map((c) => c.name);
    if (!cols.includes('merged_into')) {
      db.exec('ALTER TABLE persons ADD COLUMN merged_into INTEGER DEFAULT NULL');
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移：阶段4 访谈引擎废除 tree_id，interviews 表增加 relay_mode 列（代录关系线模式标记）
(function ensureInterviewsRelayMode() {
  try {
    const cols = db.prepare('PRAGMA table_info(interviews)').all().map((c) => c.name);
    if (!cols.includes('relay_mode')) {
      db.exec('ALTER TABLE interviews ADD COLUMN relay_mode INTEGER DEFAULT 0');
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移：interviews 增加 chapter_cursor 列（回忆录章节沉淀的增量游标：上次沉淀已覆盖到的 message id）
// 修复 P0-2：此前沉淀用全量历史，一次"亲属经历"会永久污染 isSelfStory 判定，且全量重复总结导致章节膨胀
(function ensureInterviewsChapterCursor() {
  try {
    const cols = db.prepare('PRAGMA table_info(interviews)').all().map((c) => c.name);
    if (!cols.includes('chapter_cursor')) {
      db.exec('ALTER TABLE interviews ADD COLUMN chapter_cursor INTEGER DEFAULT 0');
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移：interviews 增加 focus_chapter_id 列（2026-09-14）
// 背景：人生书「📖 回忆录」里每一章的「🎙 接着聊」要真正聚焦到**那一章**。
//   原时间线页的「再聊聊这段」只传了阶段名，点某一章进去其实是阶段级访谈 —— 名不副实。
// 语义：有值时，这场访谈沉淀时走 extendChapter 把新内容**融进这一章**，而不是按窗口新建章节；
//   同时该列进「续聊复用」的键，避免把 A 章的补讲记到 B 章头上。
(function ensureInterviewsFocusChapter() {
  try {
    const cols = db.prepare('PRAGMA table_info(interviews)').all().map((c) => c.name);
    if (!cols.includes('focus_chapter_id')) {
      db.exec('ALTER TABLE interviews ADD COLUMN focus_chapter_id INTEGER DEFAULT NULL');
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移：invitations 增加 claimed_by_user_id 列
// 背景（2026-09-13 免密认领）：75+ 的父母填不动注册表单，改为"发一条链接，点开即建号+认领+登录"。
// 这种账号**从未设过密码**，所以必须记住"这封邀请开给了哪个账号" ——
// 链接本身就是老人的钥匙：JWT 30 天过期后，他再从微信里点一次同一条链接就能重新进来。
// 没有这一列的话，邀请一旦被标记 claimed 就无法反查账号，老人掉登录态即永久进不来。
(function ensureInvitationsClaimedBy() {
  try {
    const cols = db.prepare('PRAGMA table_info(invitations)').all().map((c) => c.name);
    if (!cols.includes('claimed_by_user_id')) {
      db.exec('ALTER TABLE invitations ADD COLUMN claimed_by_user_id INTEGER');
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移：invitations 增加 kind 列 —— 'claim'（认领链接，默认）| 'login'（既有账号的免密登录链接）
// 背景（2026-09-14 用户决策）：父母这类**已经注册过账号、但从未设过可用密码**的直系亲属，
// 需要的不是"认领一个新节点"，而是"一条链接直接登进自己那个既有账号"。
//   · kind='claim'（默认，历史行为一字不变）：/auto 仍只对 id_type='link' 的账号放行自动重登，
//     保住原有安全闸门（防止"某人认领后把链接转发给别人 → 对方登成他的账号"）。
//   · kind='login'：仅由运维脚本（不在本仓库，属部署方内部工具）签发，**无 HTTP 入口**，不扩大攻击面，
//     登录目标固定为签发时绑定的那个账号，消费时再核一次"节点是否仍由该账号持有"。
// 注意：这里只是加普通列，ADD COLUMN 即可，不涉及 SQLite 无法 ALTER 的 CHECK 约束。
(function ensureInvitationsKind() {
  try {
    const cols = db.prepare('PRAGMA table_info(invitations)').all().map((c) => c.name);
    if (!cols.includes('kind')) {
      db.exec("ALTER TABLE invitations ADD COLUMN kind TEXT DEFAULT 'claim'");
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移：users.id_type 约束从 ('phone','email') 扩充以支持 'link'
// 'link' = 免密认领链接自动建的账号（identifier 形如 elder_<token前12位>@cybio.local，
// 用户永不可见、永不知道，等价于"这个账号只能用那条链接登"）。
// 不加这一档的话，只能把它谎标成 'email'，后续维护者会被误导。
// SQLite 不支持 ALTER CHECK，需重建表（与 relationships/persons 的迁移同一套路）。
(function ensureUsersIdTypeLink() {
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (!row || !row.sql) return;
    // 仅在确实是旧约束时才重建（幂等开关）
    if (!/id_type\s+IN\s*\('phone'\s*,\s*'email'\)/.test(row.sql)) return;
    db.exec(`
      BEGIN;
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT NOT NULL UNIQUE,
        id_type TEXT DEFAULT 'phone' CHECK (id_type IN ('phone','email','link')),
        real_name TEXT DEFAULT '',
        password_hash TEXT DEFAULT '',
        nickname TEXT DEFAULT '',
        avatar_url TEXT DEFAULT '',
        created_at DATETIME DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO users_new (id, identifier, id_type, real_name, password_hash, nickname, avatar_url, created_at)
        SELECT id, identifier, id_type, real_name, password_hash, nickname, avatar_url, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_identifier ON users(identifier);
      CREATE INDEX IF NOT EXISTS idx_users_realname ON users(real_name);
      COMMIT;
    `);
    console.log('[db] users.id_type 约束已扩充以支持 link（免密认领账号）');
  } catch (e) {
    console.warn('[db] users.id_type 迁移跳过:', e.message);
  }
})();

// 幂等迁移：relationships.type 约束从 ('parent','spouse') 扩充到支持 sibling/acquaintance
// SQLite 不支持 ALTER COLUMN / DROP CONSTRAINT，需重建表迁移数据
(function ensureRelationshipsTypeConstraint() {
  try {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='relationships'").get();
    if (sql && /type IN \('parent','spouse'\)/.test(sql.sql)) {
      db.exec(`
        BEGIN;
        CREATE TABLE relationships_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_person_id INTEGER NOT NULL,
          to_person_id   INTEGER NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('parent','spouse','sibling','acquaintance')),
          note TEXT DEFAULT '',
          source INTEGER,
          confidence REAL DEFAULT 1.0,
          status TEXT DEFAULT 'active' CHECK (status IN ('active','deleted')),
          created_at DATETIME DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO relationships_new (id, from_person_id, to_person_id, type, note, source, confidence, status, created_at)
          SELECT id, from_person_id, to_person_id, type, note, source, confidence, status, created_at FROM relationships;
        DROP TABLE relationships;
        ALTER TABLE relationships_new RENAME TO relationships;
        CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_person_id);
        CREATE INDEX IF NOT EXISTS idx_rel_to   ON relationships(to_person_id);
        COMMIT;
      `);
    }
  } catch (_) { /* 忽略单次失败，下次启动重试 */ }
})();

// 幂等迁移：media 增加 status 列，删除人物时改为软删（与其余实体一致，便于恢复/审计）
(function ensureMediaStatus() {
  try {
    const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
    if (!cols.includes('status')) {
      db.exec("ALTER TABLE media ADD COLUMN status TEXT DEFAULT 'active' CHECK (status IN ('active','deleted'))");
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移（2026-08-24）：persons 增加 covered_fields 列（JSON 数组）
// 记录该人物「已聊过/已填过」的字段 path 集合，用于访谈断点续聊、避免重复提问。
(function ensureCoveredFields() {
  try {
    const cols = db.prepare('PRAGMA table_info(persons)').all().map((c) => c.name);
    if (!cols.includes('covered_fields')) {
      db.exec("ALTER TABLE persons ADD COLUMN covered_fields TEXT DEFAULT '[]'");
    }
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移（2026-08-24）：persons 增加 nickname 列
// 真名 + 昵称双字段：注册时用的昵称、访谈中提到的昵称都可作为关系人对齐的别名，
// 别人提到已存在的昵称（身份匹配即可视为对上同一个人），避免重复建节点。
(function ensureNickname() {
  try {
    const cols = db.prepare('PRAGMA table_info(persons)').all().map((c) => c.name);
    if (!cols.includes('nickname')) {
      db.exec("ALTER TABLE persons ADD COLUMN nickname TEXT DEFAULT ''");
    }
  } catch (_) { /* 忽略 */ }
})();
// 回填：把注册用户填写的昵称写回其本人 person 节点（昵称用于关系人对齐）
(function backfillNickname() {
  try {
    db.exec("UPDATE persons SET nickname = (SELECT u.nickname FROM users u WHERE u.id = persons.claimed_by_user_id) WHERE claimed_by_user_id IS NOT NULL AND (nickname IS NULL OR nickname = '') AND EXISTS (SELECT 1 FROM users u WHERE u.id = persons.claimed_by_user_id AND u.nickname <> '')");
  } catch (_) { /* 忽略 */ }
})();

// 幂等迁移（本特性）：persons 状态枚举扩充 'pending_claim' + 来源追踪列
// 背景：访谈中提及的亲属，自动建「待加入/待认领」节点（pending_claim）并记录来源
// （source_user_id=谁访谈抽出的、source_interview_id=哪一访谈），等该亲属真正注册后再自动联系起来。
// SQLite 不支持 ALTER COLUMN / DROP CONSTRAINT，需重建表迁移数据。
(function ensurePersonsPendingClaim() {
  try {
    const cols = db.prepare('PRAGMA table_info(persons)').all().map((c) => c.name);
    if (cols.includes('source_user_id')) return; // 已迁移，跳过
    const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='persons'").get();
    const hasOldCheck = sqlRow && sqlRow.sql && /status IN \('active','stub','deleted'\)/.test(sqlRow.sql);
    if (!hasOldCheck) {
      // 极少见：约束已被改过 → 直接加列（pending_claim 由别处保证）
      db.exec('ALTER TABLE persons ADD COLUMN source_user_id INTEGER');
      db.exec('ALTER TABLE persons ADD COLUMN source_interview_id INTEGER');
      return;
    }
    db.exec(`
      BEGIN;
      CREATE TABLE persons_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        real_name TEXT DEFAULT '',
        claimed_by_user_id INTEGER,
        founder_user_id INTEGER,
        visibility TEXT DEFAULT 'family' CHECK (visibility IN ('self','family','public')),
        name TEXT NOT NULL,
        gender TEXT DEFAULT '',
        birth_date TEXT DEFAULT '',
        death_date TEXT DEFAULT '',
        birthplace TEXT DEFAULT '',
        residence TEXT DEFAULT '',
        occupation TEXT DEFAULT '',
        education TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        avatar_url TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        profile_json TEXT DEFAULT '{}',
        surname TEXT DEFAULT '',
        generation INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK (status IN ('active','stub','pending_claim','deleted')),
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        updated_at DATETIME DEFAULT (datetime('now','localtime')),
        merged_into INTEGER DEFAULT NULL,
        covered_fields TEXT DEFAULT '[]',
        nickname TEXT DEFAULT '',
        source_user_id INTEGER,
        source_interview_id INTEGER
      );
      INSERT INTO persons_new (id, real_name, claimed_by_user_id, founder_user_id, visibility, name, gender, birth_date, death_date, birthplace, residence, occupation, education, phone, avatar_url, bio, profile_json, surname, generation, status, created_at, updated_at, merged_into, covered_fields, nickname)
        SELECT id, real_name, claimed_by_user_id, founder_user_id, visibility, name, gender, birth_date, death_date, birthplace, residence, occupation, education, phone, avatar_url, bio, profile_json, surname, generation, status, created_at, updated_at, merged_into, covered_fields, nickname FROM persons;
      DROP TABLE persons;
      ALTER TABLE persons_new RENAME TO persons;
      CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name);
      CREATE INDEX IF NOT EXISTS idx_persons_realname ON persons(real_name);
      CREATE INDEX IF NOT EXISTS idx_persons_claim ON persons(claimed_by_user_id);
      COMMIT;
    `);
  } catch (_) { /* 忽略单次失败，下次启动重试 */ }
})();

// 辅助：给某 person 累加已覆盖字段（去重）
function addCoveredFields(personId, paths) {
  if (!personId || !paths || !paths.length) return;
  try {
    const row = db.prepare('SELECT covered_fields FROM persons WHERE id = ?').get(personId);
    let arr = [];
    try { arr = JSON.parse((row && row.covered_fields) || '[]'); } catch (_) { arr = []; }
    let changed = false;
    for (const p of paths) {
      if (p && !arr.includes(p)) { arr.push(p); changed = true; }
    }
    if (changed) {
      db.prepare('UPDATE persons SET covered_fields = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
        .run(JSON.stringify(arr), personId);
    }
  } catch (_) { /* 忽略 */ }
}
db.addCoveredFields = addCoveredFields;

// 辅助：取出某 person 的已覆盖字段数组
function getCoveredFields(personId) {
  if (!personId) return [];
  try {
    const row = db.prepare('SELECT covered_fields FROM persons WHERE id = ?').get(personId);
    try { return JSON.parse((row && row.covered_fields) || '[]'); } catch (_) { return []; }
  } catch (_) { return []; }
}
db.getCoveredFields = getCoveredFields;


// 事务适配器：node:sqlite 原生无 transaction 助手，这里补齐（路由代码零改动）
db.transaction = function (fn) {
  return function (...args) {
    db.exec('BEGIN');
    try {
      const result = fn.apply(this, args);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
};

module.exports = db;
