// test/book.test.js — 家族史书成书引擎测试
// 用临时 sqlite 库，造人物/章节/照片/关系后调用 compileBook 验证成书结构。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'cybio_book_test_' + Date.now() + '.db');
process.env.CYBIO_DB = tmp;

const db = require('../server/src/db');
require('../server/src/interview'); // 触发 memoir_chapters 的 stage/chapter_kind 幂等迁移
const { compileBook } = require('../server/src/routes/book');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

const TREE = 1;
// 确保 family_trees 有一行
db.prepare("INSERT OR IGNORE INTO family_trees(id, name, slug, owner_user_id, invite_code) VALUES(?,?,?,?,?)").run(TREE, '测试家族', 'test', 2, 'inv-test');

function mkPerson(name, opts = {}) {
  const info = db.prepare(
    "INSERT INTO persons(name, gender, birth_date, occupation, bio, status, tree_id) VALUES(?,?,?,?,?,?,?)"
  ).run(name, opts.gender || '男', opts.birth || '', opts.occ || '', opts.bio || '', opts.status || 'active', TREE);
  return Number(info.lastInsertRowid);
}
function mkChapter(pid, title, stage, summary, excerpt) {
  db.prepare("INSERT INTO memoir_chapters(tree_id, person_id, title, summary, excerpt, stage) VALUES(?,?,?,?,?,?)")
    .run(TREE, pid, title, summary || '', excerpt || '', stage || 'life');
}
function mkMedia(pid, url, caption) {
  db.prepare("INSERT INTO media(tree_id, person_id, url, type, caption) VALUES(?,?,?,?,?)").run(TREE, pid, url, 'photo', caption || '');
}

const ye = mkPerson('李烨', { gender: '男', birth: '1955', occ: '工程师', bio: '一生勤勉。' });
const binwei = mkPerson('李斌伟', { status: 'stub', gender: '男' }); // 待本人自述
mkChapter(ye, '童年记忆', 'childhood', '小时候在苏州河边。', '河水很清。');
mkChapter(ye, '青年求学', 'youth', '考上大学。', '背着铺盖去省城。');
mkMedia(ye, '/uploads/test1.jpg', '1982 年老屋前全家福');
mkMedia(ye, '/uploads/test2.jpg', ''); // 待配文
db.prepare("INSERT INTO relationships(tree_id, from_person_id, to_person_id, type) VALUES(?,?,?,?)").run(TREE, binwei, ye, 'parent');

console.log('家族史书成书测试：');

test('成书：封面含家族名与统计', () => {
  const book = compileBook(TREE);
  assert.strictEqual(book.cover.familyName, '测试家族');
  assert.ok(book.cover.generatedAt, '应有生成日期');
  assert.strictEqual(book.stats.personCount, 2);
  assert.strictEqual(book.stats.chapterCount, 2);
  assert.strictEqual(book.stats.photoCount, 2);
});

test('成书：已采编人物进正文，stub 进待续', () => {
  const book = compileBook(TREE);
  const mains = book.biographies.filter((b) => !b.isStub);
  assert.ok(mains.some((b) => b.id === ye), '李烨应进正文');
  assert.ok(book.pending.some((b) => b.id === binwei), '李斌伟(stub)应进待续附录');
});

test('成书：章节按阶段排序且照片入书', () => {
  const book = compileBook(TREE);
  const b = book.biographies.find((x) => x.id === ye);
  assert.strictEqual(b.chapters.length, 2);
  assert.strictEqual(b.chapters[0].stage, 'childhood', '童年应排在青年前');
  assert.strictEqual(b.media.length, 2, '应含 2 张照片');
  assert.strictEqual(b.media[0].caption, '1982 年老屋前全家福');
});

test('成书：目录只列有内容的已采编者', () => {
  const book = compileBook(TREE);
  assert.ok(book.toc.some((t) => t.id === ye), '李烨应入目录');
  assert.ok(!book.toc.some((t) => t.id === binwei), 'stub 不入正文目录');
});

test('成书：关系脉络含父系根', () => {
  const book = compileBook(TREE);
  assert.ok(book.lineage.length >= 1, '应有脉络');
  const hasYe = book.lineage.some((l) => l.root.id === binwei || l.children.some((c) => c.id === ye));
  assert.ok(hasYe, '脉络应含李斌伟→李烨');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
try { fs.unlinkSync(tmp); } catch (_) {}
process.exit(fail ? 1 : 0);
