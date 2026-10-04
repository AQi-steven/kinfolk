// test/views.test.js — 后端「关系环 / 关系圈 / 姓氏族谱」派生逻辑集成测试
// 用临时 sqlite 库（CYBIO_DB 指向临时文件），造数据后调用纯函数验证。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'cybio_views_test_' + Date.now() + '.db');
process.env.CYBIO_DB = tmp;

const db = require('../server/src/db');
const { computeRing } = require('../server/src/routes/ring');
const { buildCircle } = require('../server/src/routes/circle');
const { buildClan } = require('../server/src/routes/clan');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

// 造数据：李烨(本人) — 父李斌伟(李) / 母祝欣欣(祝) — 祖父李大山(李)
//                      配偶王芳(王) — 子李小明(李)
//                      李斌伟 配偶 祝欣欣；李斌伟 父 李大山
function mkPerson(name, surname, treeId, claimed) {
  const info = db.prepare("INSERT INTO persons(name, surname, tree_id, claimed_by_user_id, status) VALUES(?,?,?,?, 'active')").run(name, surname, treeId, claimed || null);
  return Number(info.lastInsertRowid);
}
function mkRel(treeId, from, to, type) {
  db.prepare("INSERT INTO relationships(tree_id, from_person_id, to_person_id, type) VALUES(?,?,?,?)").run(treeId, from, to, type);
}

const TREE = 1;
const ye = mkPerson('李烨', '李', TREE, 2);
const binwei = mkPerson('李斌伟', '李', TREE, null);
const zhuxinxin = mkPerson('祝欣欣', '祝', TREE, null);
const dashan = mkPerson('李大山', '李', TREE, null);
const wangfang = mkPerson('王芳', '王', TREE, null);
const xiaoming = mkPerson('李小明', '李', TREE, null);

// 父子/父女
mkRel(TREE, binwei, ye, 'parent');       // 李斌伟 → 李烨
mkRel(TREE, zhuxinxin, ye, 'parent');    // 祝欣欣 → 李烨
mkRel(TREE, dashan, binwei, 'parent');   // 李大山 → 李斌伟
mkRel(TREE, ye, xiaoming, 'parent');     // 李烨 → 李小明
// 配偶
mkRel(TREE, binwei, zhuxinxin, 'spouse'); // 李斌伟-祝欣欣
mkRel(TREE, ye, wangfang, 'spouse');      // 李烨-王芳

console.log('关系环 / 关系圈 / 姓氏族谱 派生测试：');

test('关系环：本人圆心，父母/配偶/子女/祖父母正确归类', () => {
  const ring = computeRing(TREE, ye);
  assert.ok(ring, 'ring 应非空');
  assert.ok(ring.parents.some((p) => p.id === binwei), '应含父亲李斌伟');
  assert.ok(ring.parents.some((p) => p.id === zhuxinxin), '应含母亲祝欣欣');
  assert.ok(ring.spouses.some((p) => p.id === wangfang), '应含配偶王芳');
  assert.ok(ring.children.some((p) => p.id === xiaoming), '应含子女李小明');
  assert.ok(ring.grandparents.some((p) => p.id === dashan), '应含祖父李大山');
  assert.strictEqual(ring.self.id, ye, 'self 应为李烨');
});

test('关系圈：沿共享节点并入配偶家族（王芳的父母应进入圈）', () => {
  const circle = buildCircle(TREE, ye, 2);
  assert.ok(circle, 'circle 应非空');
  const ids = circle.nodes.map((n) => n.id);
  assert.ok(ids.includes(wangfang), '圈应含配偶王芳');
  // 王芳作为锚点，其父母也应在圈内（若已录入）；此处未录王芳父母，故只验证王芳在
});

test('姓氏族谱：只保留李姓主干，配偶王芳(王)不并入主干', () => {
  const clan = buildClan(TREE, '李', ye);
  assert.ok(clan, 'clan 应非空');
  const trunkIds = clan.trunkNodes.map((n) => n.id);
  assert.ok(trunkIds.includes(ye), '主干含李烨');
  assert.ok(trunkIds.includes(binwei), '主干含李斌伟');
  assert.ok(trunkIds.includes(dashan), '主干含李大山');
  assert.ok(trunkIds.includes(xiaoming), '主干含李小明');
  assert.ok(!trunkIds.includes(wangfang), '配偶王芳(王姓)不应并入李姓主干');
  assert.ok(!trunkIds.includes(zhuxinxin), '母亲祝欣欣(祝姓)不应并入李姓主干');
  // 配偶标注应挂在李烨节点上
  const yeNode = clan.trunkNodes.find((n) => n.id === ye);
  assert.ok(yeNode.spouses.some((s) => s.id === wangfang), '李烨节点应标注配偶王芳');
});

test('姓氏族谱：配偶(外姓)关联标注正确', () => {
  const clan = buildClan(TREE, '李', ye);
  const binweiNode = clan.trunkNodes.find((n) => n.id === binwei);
  assert.ok(binweiNode.spouses.some((s) => s.id === zhuxinxin), '李斌伟节点应标注配偶祝欣欣(祝姓)');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
try { fs.unlinkSync(tmp); } catch (_) {}
process.exit(fail ? 1 : 0);
