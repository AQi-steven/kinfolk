// test/ingest-guard.test.js —— 第三层入库前校验兜底回归测试
const assert = require('assert');
const { sanitizeExtract, sanitizeFacts, normalizeGender, normalizeDate, dedupeRelations } = require('../server/src/ingest-guard');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n    ', e.message); fail++; }
}

console.log('ingest-guard 第三层测试：');

// --- 姓名终审：非姓名被剔除 ---
test('K6: 江苏武进人 不能当姓名进入 relations', () => {
  const { safeExtract, warnings } = sanitizeExtract(
    { person: { name: '李烨' }, relations: [{ rel: 'friend', name: '江苏武进人' }] },
    { name: '李烨' }
  );
  assert.strictEqual(safeExtract.relations.length, 0, '关系人应被剔除');
  assert.ok(warnings.some((w) => w.includes('非姓名')), '应记录非姓名警告');
});

test('K6: 家族里的老大 不能当姓名', () => {
  const { safeExtract, warnings } = sanitizeExtract(
    { person: { name: '李烨' }, relations: [{ rel: 'other', name: '家族里的老大' }] },
    { name: '李烨' }
  );
  assert.strictEqual(safeExtract.relations.length, 0);
  assert.ok(warnings.some((w) => w.includes('非姓名')));
});

// --- 本人防护：关系人姓名与本人相同 → 不建关系节点 ---
test('本人防护: 关系人姓名=本人名 被跳过', () => {
  const { safeExtract, warnings } = sanitizeExtract(
    { person: { name: '李烨' }, relations: [{ rel: 'father', name: '李烨' }] },
    { name: '李烨' }
  );
  assert.strictEqual(safeExtract.relations.length, 0, '本人不应作为关系人建节点');
  assert.ok(warnings.some((w) => w.includes('本人防护')));
});

// --- 性别归一 ---
test('性别脏值清空', () => {
  assert.strictEqual(normalizeGender('未知'), '');
  assert.strictEqual(normalizeGender('男的'), '男');
  assert.strictEqual(normalizeGender('女性'), '女');
  assert.strictEqual(normalizeGender('男'), '男');
});

// --- 日期归一：K1 "2008年结婚" 不污染 birth_date ---
test('K1: 非法日期清空（结婚年份不污染生日）', () => {
  const { safeExtract } = sanitizeExtract(
    { person: { name: '李烨', birth_date: '2008年结婚' } },
    { name: '李烨' }
  );
  assert.strictEqual(safeExtract.person.birth_date, '', '非法日期应清空');
});

test('合法日期保留', () => {
  assert.strictEqual(normalizeDate('1955'), '1955');
  assert.strictEqual(normalizeDate('1955-3'), '1955-03');
  assert.strictEqual(normalizeDate('1955-03-12'), '1955-03-12');
  assert.strictEqual(normalizeDate('abc'), '');
});

// --- 关系去重：同名同 rel 合并（轻量字段下合并 note） ---
test('relations 同名同 rel 去重', () => {
  const rels = [
    { rel: 'father', name: '李冰伟', note: '' },
    { rel: 'father', name: '李冰伟', gender: '男', note: '老兵' },
  ];
  const out = dedupeRelations(rels, []);
  assert.strictEqual(out.length, 1, '应合并为1条');
  assert.strictEqual(out[0].note, '老兵', '后续非空 note 应合并进来');
  assert.strictEqual(out[0].gender, '男', '后续非空 gender 应合并进来');
});

// --- life_events 空串过滤 ---
test('life_events 空串过滤', () => {
  const { safeExtract } = sanitizeExtract(
    { person: { name: '李烨', life_events: ['2008年结婚', '', '  ', '2010年生子'] } },
    { name: '李烨' }
  );
  assert.deepStrictEqual(safeExtract.person.life_events, ['2008年结婚', '2010年生子']);
});

// --- 复核 facts 同样拦截本人防护 + 非姓名 ---
test('sanitizeFacts 复核也挡非姓名', () => {
  const { safeFacts, warnings } = sanitizeFacts(
    { person: { name: '李烨' }, relations: [{ rel: 'mother', name: '苏州人' }] },
    { name: '李烨' }
  );
  assert.strictEqual(safeFacts.relations.length, 0);
  assert.ok(warnings.some((w) => w.includes('非姓名')));
});

test('sanitizeFacts 复核本人防护', () => {
  const { safeFacts } = sanitizeFacts(
    { person: { name: '李烨' }, relations: [{ rel: 'spouse', name: '李烨' }] },
    { name: '李烨' }
  );
  assert.strictEqual(safeFacts.relations.length, 0);
});

// --- review 净化：非姓名移出复核框 ---
test('复核框净化: 非姓名移出 review', () => {
  const { safeExtract, warnings } = sanitizeExtract(
    {
      person: { name: '李烨' },
      review: [{ label: '父亲姓名', value: '江苏武进人', path: 'relations[0].name' }],
    },
    { name: '李烨' }
  );
  assert.strictEqual(safeExtract.review.length, 0, '非姓名 review 应被移除');
  assert.ok(warnings.some((w) => w.includes('复核框净化')));
});

// --- 亲属轻量：深度字段不进入关系节点 ---
test('亲属节点只保留 name/gender/rel/note，深度字段被清', () => {
  const { safeExtract } = sanitizeExtract(
    {
      person: { name: '李烨' },
      relations: [{ rel: 'father', name: '李斌伟', birth_date: '1950', birthplace: '苏州', occupation: '教师', note: '老兵' }],
    },
    { name: '李烨' }
  );
  const r = safeExtract.relations[0];
  assert.ok(r, '应保留关系节点');
  assert.strictEqual(r.name, '李斌伟');
  assert.strictEqual(r.rel, 'father');
  assert.strictEqual(r.note, '老兵');
  assert.strictEqual(r.birth_date, undefined, '亲属生日不应保留');
  assert.strictEqual(r.birthplace, undefined, '亲属籍贯不应保留');
  assert.strictEqual(r.occupation, undefined, '亲属职业不应保留');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
