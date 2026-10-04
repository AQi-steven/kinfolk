// server/src/chapter-history.js
// 章节正文版本历史（2026-10-04）
//
// 背景：此前 memoir_chapters.summary 被直接覆盖 —— 用户改一次，AI 写的原文就没了。
//   传记正文是不可再生的资产（老人的一生只讲一次），改坏了必须能回退。
//
// 设计取舍：
//   1. **只存快照，不存 diff**：正文只有几百字，全量存比 diff 更简单也更不容易出错；
//      代价是磁盘略大（每版约 1KB，保留 20 版 ≈ 20KB/章，可接受）。
//   2. **上限 20 版/章**：无限增长会让 SQLite 膨胀，也没人会翻到第 50 版。
//   3. **只记旧值**：回滚 = 把快照写回，再给"回滚前的样子"也存一版（形成可逆操作链）。
//   4. 所有改正文的路径都必须经过 snapshotChapter()，漏一处就漏一次数据丢失。
const db = require('./db');

const MAX_VERSIONS = 20;

// 改动前先存一份旧值。返回版本 id（失败返回 null，不阻断主流程 —— 正文写入比留痕更重要）
function snapshotChapter(chapterId, userId, source, note) {
  try {
    const ch = db.prepare('SELECT id, person_id, title, summary, excerpt, year FROM memoir_chapters WHERE id = ?').get(chapterId);
    if (!ch) return null;
    const info = db.prepare(
      'INSERT INTO chapter_versions(chapter_id, person_id, title, summary, excerpt, year, source, note, by_user_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(ch.id, ch.person_id, ch.title || '', ch.summary || '', ch.excerpt || '',
         ch.year == null ? null : ch.year,
         source || 'edit', note || '', userId == null ? null : userId);
    pruneVersions(ch.id);
    return Number(info.lastInsertRowid);
  } catch (e) {
    console.warn('[chapter-history] 留痕失败（不影响正文写入）:', e.message);
    return null;
  }
}

// 超出上限时淘汰最旧的（只留最近 MAX_VERSIONS 条）
// ⚠️ 为什么要单独包 try 并打警告：prune 失败不会中断正文写入（那是更重要的操作），
//   但若它长期静默失败，chapter_versions 会无限膨胀把库撑大。
//   所以失败必须留日志痕迹，便于巡检发现。
function pruneVersions(chapterId) {
  try {
    const res = db.prepare(
      'DELETE FROM chapter_versions WHERE chapter_id = ? AND id NOT IN (' +
      'SELECT id FROM chapter_versions WHERE chapter_id = ? ORDER BY id DESC LIMIT ?)'
    ).run(chapterId, chapterId, MAX_VERSIONS);
    if (res && res.changes > 0) {
      console.log(`[chapter-history] 章节 ${chapterId} 淘汰旧版本 ${res.changes} 条（保留最近 ${MAX_VERSIONS}）`);
    }
  } catch (e) {
    // 🔴 静默失败会导致版本表无限增长 —— 这里明确告警，不要降级为静默
    console.error(`[chapter-history] 🔴 清理旧版本失败（chapter_versions 可能持续膨胀）: ${e.message}`);
  }
}

// 列出版本（新的在前）
function listVersions(chapterId, limit) {
  return db.prepare(
    'SELECT id, title, summary, excerpt, year, source, note, by_user_id, created_at ' +
    'FROM chapter_versions WHERE chapter_id = ? ORDER BY id DESC LIMIT ?'
  ).all(chapterId, Math.min(Math.max(1, limit || 20), 50));
}

function getVersion(id) {
  return db.prepare('SELECT * FROM chapter_versions WHERE id = ?').get(id);
}

// 取章节当前正文（回滚时需要先存当前值再覆盖）
function getChapterForRollback(chapterId) {
  return db.prepare('SELECT id, person_id, title, summary, excerpt, year FROM memoir_chapters WHERE id = ?').get(chapterId);
}

module.exports = { snapshotChapter, listVersions, getVersion, getChapterForRollback, MAX_VERSIONS };
