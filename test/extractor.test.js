// test/extractor.test.js
// ============================================================
// 第二层抽取模块（解耦层） —— 回归测试
// 运行：node test/extractor.test.js
// 零外部依赖，无 API Key 时走第一层规则保底（与线上 demoMode 一致）
// ============================================================
const assert = require('assert');
const { extractFromText } = require('../server/src/extractor');

let pass = 0;
let fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    pass++;
    console.log('  ✓ ' + name);
  }).catch((e) => {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + e.message);
  });
}

async function run() {
  console.log('\n=== 第二层：extractFromText 解耦入口（演示模式/规则保底） ===');

  // K1：2008结婚 不能当出生
  await test('"我2008年结婚" → birth_date 为空，life_events 含结婚', async () => {
    const ext = await extractFromText('我2008年结婚，在老家办的', { targetName: '李烨' });
    assert.strictEqual(ext.person.birth_date, '', 'birth_date 绝不能是 2008');
    assert.ok(ext.person.life_events.some((x) => x.includes('结婚')), '应归入人生事件');
  });

  // K2：父亲名字不能污染本人姓名
  await test('"我的父亲名字叫李冰伟" → 本人姓名=李烨(targetName兜底)，父亲姓名=李冰伟', async () => {
    const ext = await extractFromText('我的父亲名字叫李冰伟', { targetName: '李烨' });
    assert.strictEqual(ext.person.name, '李烨', '本人姓名应兜底为 targetName，不被父亲名污染');
    const father = ext.relations.find((r) => r.rel === 'father');
    assert.ok(father && father.name === '李冰伟', '父亲姓名应正确提取');
  });

  // K2：籍贯不能当姓名
  await test('"我父亲是江苏武进人" → 无带名父亲，birthplace=江苏武进', async () => {
    const ext = await extractFromText('我父亲是江苏武进人', { targetName: '李烨' });
    const father = ext.relations.find((r) => r.rel === 'father');
    assert.ok(!father || father.name === '', '父亲不应被提取出姓名');
    assert.ok(!father || father.birthplace === '江苏武进', '籍贯应走 birthplace');
  });

  // K6：配偶姓名必须进 review
  await test('"我老婆叫王芳" → 配偶姓名进 review 复核清单', async () => {
    const ext = await extractFromText('我老婆叫王芳，我们是2010年认识的', { targetName: '李烨' });
    const spouse = ext.relations.find((r) => r.rel === 'spouse');
    assert.ok(spouse && spouse.name === '王芳', '配偶姓名应提取');
    assert.ok(ext.review.some((x) => x.label.includes('配偶') && x.value === '王芳'), '配偶姓名应出现在 review');
  });

  // 解耦验证：返回结构含 person/relations/review，且本人姓名兜底
  await test('无 apiKey 时走规则保底，返回结构完整', async () => {
    const ext = await extractFromText('我叫李烨，男性，1955年出生在苏州', { targetName: '' });
    assert.strictEqual(ext.person.name, '李烨');
    assert.strictEqual(ext.person.gender, '男');
    assert.strictEqual(ext.person.birth_date, '1955');
    assert.strictEqual(ext.person.birthplace, '苏州');
    assert.ok(Array.isArray(ext.review), 'review 应为数组');
  });

  // 已确认 path 过滤
  await test('已确认的 path 不再出现在 review', async () => {
    const confirmed = new Set(['person.name']);
    const ext = await extractFromText('我叫李烨', { targetName: '', confirmedPaths: confirmed });
    assert.ok(!ext.review.some((x) => x.path === 'person.name'), 'person.name 已确认不应再弹');
  });

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
