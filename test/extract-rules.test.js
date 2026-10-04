// test/extract-rules.test.js
// ============================================================
// 第一层抽取规则模块 —— 踩坑回归测试
// 运行：node test/extract-rules.test.js
// 零外部依赖，使用 Node 内置 assert
// ============================================================
const assert = require('assert');
const {
  cleanName, isLikelyName, formatDate, extractDates,
  relationMentions, ruleExtract, buildRuleReview,
  augmentMissingFamilyNames, relLabel,
} = require('../server/src/extract-rules');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

console.log('\n=== K2 名字误抓防护 ===');

test('籍贯"江苏武进人"不得被当成父亲姓名', () => {
  const m = relationMentions('我的父亲是江苏武进人');
  // 没有"叫/名为"引入词 → 不应生成有名字的 father
  assert.strictEqual(m.length, 0, '不应提取出带名字的父亲条目');
});

test('描述"家族里的老大"不得被当成父亲姓名', () => {
  const m = relationMentions('我的父亲是家族里的老大');
  assert.strictEqual(m.length, 0, '不应提取出带名字的父亲条目');
});

test('isLikelyName 拒绝籍贯/描述/代词', () => {
  assert.strictEqual(isLikelyName('江苏武进人'), false);
  assert.strictEqual(isLikelyName('家族里的老大'), false);
  assert.strictEqual(isLikelyName('苏州人'), false);
  assert.strictEqual(isLikelyName('父亲'), false);
  assert.strictEqual(isLikelyName('我'), false);
});

test('"我的父亲名字叫李冰伟" → 父亲姓名=李冰伟，且本人姓名≠李冰伟', () => {
  const ext = ruleExtract('我的父亲名字叫李冰伟，他是1948年4月15号出生', '李烨');
  const father = ext.relations.find((r) => r.rel === 'father');
  assert.ok(father, '应有父亲条目');
  assert.strictEqual(father.name, '李冰伟');
  assert.strictEqual(ext.person.name, '李烨', '本人姓名不应被父亲名字污染');
});

test('"母亲姓名是祝星星" → 母亲姓名=祝星星', () => {
  const ext = ruleExtract('我的母亲姓名是祝星星，1951年的7月2号出生', '李烨');
  const mother = ext.relations.find((r) => r.rel === 'mother');
  assert.ok(mother);
  assert.strictEqual(mother.name, '祝星星');
});

console.log('\n=== K1 生日误抓防护 ===');

test('"我2008年结婚"的年份不得当成本人生日', () => {
  const ext = ruleExtract('我2008年结婚，妻子叫姜明月', '父亲');
  assert.strictEqual(ext.person.birth_date, '', '本人生日不应被事件年份污染');
});

test('"我出生于1949年"才进 birth_date', () => {
  const ext = ruleExtract('我出生于1949年10月1日', '父亲');
  assert.strictEqual(ext.person.birth_date, '1949-10-01');
});

test('事件年份应进 life_events 而非 birth_date', () => {
  const ext = ruleExtract('我2008年结婚，妻子叫姜明月', '父亲');
  assert.ok(ext.person.life_events.includes('2008年结婚'), '应包含带年份的结婚事件');
});

console.log('\n=== K3 籍贯抽取（不污染 name） ===');

test('"父亲是江苏武进人" → 父亲 birthplace=江苏武进，name 为空', () => {
  const m = relationMentions('我的父亲是江苏武进人，我的母亲是苏州人');
  // 两个都没有引入词 → 无 name；但 birthplace 在 ruleExtract 中处理
  const ext = ruleExtract('我的父亲是江苏武进人，我的母亲是苏州人', '李烨');
  const father = ext.relations.find((r) => r.rel === 'father');
  const mother = ext.relations.find((r) => r.rel === 'mother');
  assert.strictEqual(father && father.name, undefined, '父亲不应有名字');
  assert.strictEqual(mother && mother.name, undefined, '母亲不应有名字');
});

test('"父亲名字叫X，是江苏武进人" → 既有 name 又有 birthplace', () => {
  const ext = ruleExtract('我的父亲名字叫李冰伟，他是江苏武进人', '李烨');
  const father = ext.relations.find((r) => r.rel === 'father');
  assert.strictEqual(father.name, '李冰伟');
  assert.strictEqual(father.birthplace, '江苏武进');
});

console.log('\n=== K4 关系人去重 ===');

test('同一句话多次提到"我的父亲"只生成一个父亲条目', () => {
  const ext = ruleExtract('我的父亲叫李冰伟。我的父亲是江苏武进人，我的父亲是家族里的老大', '李烨');
  const fathers = ext.relations.filter((r) => r.rel === 'father');
  assert.strictEqual(fathers.length, 1, '父亲条目应去重为 1 个');
  assert.strictEqual(fathers[0].name, '李冰伟');
});

console.log('\n=== K5 口语日期 ===');

test('"1951年的7月2号"正确解析为 1951-07-02', () => {
  const d = extractDates('我的母亲是1951年的7月2号出生')[0];
  assert.ok(d);
  assert.strictEqual(formatDate(d.y, d.mo, d.d), '1951-07-02');
});

test('"1948年4月15号"正确解析', () => {
  const d = extractDates('他是1948年4月15号出生')[0];
  assert.strictEqual(formatDate(d.y, d.mo, d.d), '1948-04-15');
});

console.log('\n=== K6 配偶漏抽兜底 ===');

test('规则能补出模型漏掉的配偶姓名', () => {
  const modelReview = []; // 模型漏了配偶
  const augmented = augmentMissingFamilyNames(modelReview, '我结婚了，妻子叫姜明月', new Set());
  const spouseNameItem = augmented.find((r) => r.label === '配偶·姓名');
  assert.ok(spouseNameItem, '兜底应补出配偶姓名复核项');
  assert.strictEqual(spouseNameItem.value, '姜明月');
});

test('模型已含配偶姓名时不再重复补', () => {
  const modelReview = [{ label: '配偶·姓名', value: '姜明月', path: 'relations[0].name' }];
  const augmented = augmentMissingFamilyNames(modelReview, '我结婚了，妻子叫姜明月', new Set());
  const spouseItems = augmented.filter((r) => r.label === '配偶·姓名');
  assert.strictEqual(spouseItems.length, 1, '不应重复');
});

console.log('\n=== 已确认集合（避免重复确认） ===');

test('已确认的 path 不再出现在 review 清单', () => {
  const ext = ruleExtract('我的父亲叫李冰伟，1948年出生，江苏武进人，是个老师', '李烨');
  const confirmed = new Set(['relations[0].name']);
  const review = buildRuleReview(ext, confirmed);
  const labels = review.map((r) => r.label);
  assert.ok(!labels.includes('父亲·姓名'), '父亲姓名已确认不应再弹');
  assert.ok(!labels.includes('父亲·出生时间'), '亲属生日不弹复核，自然也不应再弹');
});

test('未确认的字段正常出现（亲属只弹姓名，不弹生日/籍贯/职业）', () => {
  const ext = ruleExtract('我的父亲叫李冰伟，1948年出生，江苏武进人，是个老师', '李烨');
  const review = buildRuleReview(ext, new Set());
  const labels = review.map((r) => r.label);
  assert.ok(labels.includes('父亲·姓名'), '亲属姓名应进入复核');
  assert.ok(!labels.includes('父亲·出生时间'), '亲属生日不应进入复核');
  assert.ok(!labels.includes('父亲·籍贯'), '亲属籍贯不应进入复核');
  assert.ok(!labels.includes('父亲·职业'), '亲属职业不应进入复核');
});

console.log('\n=== 重复 review 去重 ===');

test('buildRuleReview 对同 label:value 去重', () => {
  const ext = {
    person: { name: '李烨' },
    relations: [
      { rel: 'father', name: '李冰伟', birth_date: '1948' },
      { rel: 'father', name: '李冰伟', birth_date: '1948' }, // 模拟模型重复返回
    ],
    link_names: [],
  };
  const review = buildRuleReview(ext, new Set());
  const fatherNames = review.filter((r) => r.label === '父亲·姓名');
  assert.strictEqual(fatherNames.length, 1, '不应出现两条父亲姓名');
});

console.log('\n=== 双节点防护（逻辑层：同 rel 唯一） ===');

test('ruleExtract 同类型亲属只产生一个节点数据（applyExtraction 据此复用，不产生双节点）', () => {
  const ext = ruleExtract('我的父亲叫李冰伟。我爸是1948年出生的', '李烨');
  const fathers = ext.relations.filter((r) => r.rel === 'father');
  assert.strictEqual(fathers.length, 1, '数据层同rel唯一 → 写入时按rel复用节点，不会双节点');
});

console.log('\n=== relLabel 映射 ===');

test('关系类型中文标签正确', () => {
  assert.strictEqual(relLabel('father'), '父亲');
  assert.strictEqual(relLabel('spouse'), '配偶');
  assert.strictEqual(relLabel('daughter'), '女儿');
  assert.strictEqual(relLabel('friend'), '朋友');
});

console.log(`\n========================================
  通过 ${pass} 项，失败 ${fail} 项
========================================`);
process.exit(fail ? 1 : 0);
