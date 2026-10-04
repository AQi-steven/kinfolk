// test/relay.test.js —— 代录关系线模式回归测试
// 验证：代录模式下 target(亲属节点) 不被当作传记主角填充深度字段，
// 只连「本人↔亲属」关系边 + 记录 name/note，且不沉淀回忆录章节。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'cybio_relay_test_' + Date.now() + '.db');
process.env.CYBIO_DB = tmp;

const db = require('../server/src/db');
const iv = require('../server/src/interview');
const { runInterview } = require('../server/src/llm');
const { sanitizeExtract } = require('../server/src/ingest-guard');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
  })());
}

const TREE = 1;
// 本人（已认领）
const selfInfo = db.prepare("INSERT INTO persons(name, surname, tree_id, claimed_by_user_id, status) VALUES('李烨','李',?,2,'active')").run(TREE);
const selfId = Number(selfInfo.lastInsertRowid);
// 亲属 stub 节点（待本人自述）
const relInfo = db.prepare("INSERT INTO persons(name, surname, tree_id, status) VALUES('李斌伟','李',?,'stub')").run(TREE);
const relId = Number(relInfo.lastInsertRowid);

console.log('代录关系线模式测试：');

test('startInterview 带 relay_mode 标记访谈为代录', async () => {
  const r = await iv.startInterview({ treeId: TREE, userId: 2, type: 'person_claim', targetPersonId: relId, relayMode: true });
  const row = db.prepare('SELECT relay_mode FROM interviews WHERE id = ?').get(r.interviewId);
  assert.strictEqual(row.relay_mode, 1, 'relay_mode 应为 1');
});

test('代录模式：applyExtraction 不填充 target 的生平字段', () => {
  const interview = { target_person_id: relId, user_id: 2 };
  const extract = {
    person: { name: '李斌伟', gender: '男', birth_date: '1955', birthplace: '苏州', occupation: '教师' },
    relations: [{ rel: 'father', name: '李斌伟', note: '老教师' }],
    review: [],
  };
  const res = iv.applyExtraction(interview, extract, TREE, true);
  const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(relId);
  assert.strictEqual(p.birth_date, '', '代录不应写生日');
  assert.strictEqual(p.birthplace, '', '代录不应写籍贯');
  assert.strictEqual(p.occupation, '', '代录不应写职业');
  assert.ok(res.captured.includes('relation.father'), '应捕获关系');
  // 关系边应连到本人
  const edge = db.prepare("SELECT * FROM relationships WHERE tree_id = ? AND ((from_person_id = ? AND to_person_id = ?) OR (from_person_id = ? AND to_person_id = ?)) AND type = 'parent'").get(
    TREE, relId, selfId, selfId, relId
  );
  assert.ok(edge, '应存在 李斌伟→李烨 的 parent 边');
});

test('代录模式：只处理与本人相关的那一条关系（不展开亲属的其他亲属）', () => {
  const interview = { target_person_id: relId, user_id: 2 };
  // 用户说「李斌伟是我爸」，同时提到「他还有个兄弟叫李小强」——但代录只应处理与本人关系
  const extract = {
    person: { name: '李斌伟' },
    relations: [
      { rel: 'father', name: '李斌伟', note: '退休教师' },
      { rel: 'brother', name: '李小强' }, // 弱关系/其他，应被忽略
    ],
    review: [],
  };
  const before = db.prepare('SELECT COUNT(*) c FROM persons WHERE tree_id = ? AND name = ?').get(TREE, '李小强');
  iv.applyExtraction(interview, extract, TREE, true);
  const after = db.prepare('SELECT COUNT(*) c FROM persons WHERE tree_id = ? AND name = ?').get(TREE, '李小强');
  assert.strictEqual(before.c, after.c, '代录不应新建亲属的其他亲属节点');
});

test('代录模式：prompt 不进入传记深挖（buildSystemPrompt relayMode 分支）', async () => {
  const sys = require('../server/src/llm').buildSystemPrompt([], '李斌伟', {}, [], true);
  assert.ok(sys.includes('代录'), 'relayMode prompt 应说明代录关系线');
  assert.ok(sys.includes('绝对不要去问 TA 的生日'), 'relayMode prompt 应禁止问生日/籍贯/职业');
});

test('代录模式：finishInterview 不沉淀回忆录章节', async () => {
  const r = await iv.startInterview({ treeId: TREE, userId: 2, type: 'person_claim', targetPersonId: relId, relayMode: true });
  const res = await iv.finishInterview(r.interviewId);
  assert.strictEqual(res.chapter, null, '代录不应生成回忆录章节');
  const cnt = db.prepare('SELECT COUNT(*) c FROM memoir_chapters WHERE tree_id = ? AND person_id = ?').get(TREE, relId);
  assert.strictEqual(cnt.c, 0, '代录不应写回忆录章节');
});

(async () => {
  await Promise.all(pending);
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  try { fs.unlinkSync(tmp); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
