// server/src/bookgen.js
// 赛博传记 — 成书引擎（2026-10-04）
//
// 为什么要有：用户讲完不能只留在网页里。传记最终要能"拿走"——给子女一份、能打印、
// ��打印出来摆在桌上。竞品 chaoshan-lifebook 证明纯函数模板引擎完全可行。
//
// 设计原则：
//   1. **纯函数**：只依赖入参，不读库不请求，便于测试与未来复用到 PDF/分享。
//   2. **内容全部转义**：正文来自用户与模型，一律走 esc()，绝不在书里留可执行 HTML。
//   3. **可打印**：@media print 断章分页，浏览器"打印→存 PDF"即得成品书。
//   4. **照片用绝对 URL**：成书 HTML 要能独立转发给家人，图片不能是相对路径。
//   5. **原音可选**：只在本人生成的私密版里嵌入；共享版不含音频链接（见调用方约定）。
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 人生阶段顺序（与前端 LIFE_LADDER 保持一致；不同则书里分组会乱序）
const STAGE_ORDER = [
  { key: 'childhood', label: '童年' },
  { key: 'youth', label: '青年' },
  { key: 'work', label: '工作' },
  { key: 'family', label: '家庭' },
  { key: 'life', label: '人生片段' },
];

// 把章节按年份升序、无年份排末尾
function sortChapters(chapters) {
  return [...(chapters || [])].sort((a, b) => {
    const ay = a.year == null ? 99999 : a.year;
    const by = b.year == null ? 99999 : b.year;
    if (ay !== by) return ay - by;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
}

// 年华剪影：只取有年份的章节条目
function buildTimeline(chapters) {
  return sortChapters(chapters)
    .filter((c) => c.year != null)
    .map((c) => ({ year: c.year, title: c.title, stage: c.stage }));
}

// 章节正文块。photos 形如 [{url, caption}]，quotes 形如 [{text, audioUrl}]
function chapterHtml(c, opts) {
  const o = opts || {};
  const photos = c.photos || [];
  const quotes = c.quotes || [];
  let html = '';
  html += `
  <section class="bk-chapter">
    <div class="bk-chapter-head">
      <h2>${esc(c.title || '未命名章节')}</h2>
      ${c.year != null ? `<div class="bk-year">${esc(c.year)} 年</div>` : ''}
    </div>`;
  if (c.excerpt) html += `<blockquote class="bk-excerpt">${esc(c.excerpt)}</blockquote>`;
  if (c.summary) html += `<div class="bk-body-text">${esc(c.summary)}</div>`;

  if (photos.length) {
    html += '<div class="bk-photos">';
    for (const p of photos) {
      html += `<figure><img src="${esc(p.url)}" alt="${esc(p.caption || '照片')}"/>` +
        (p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : '') + '</figure>';
    }
    html += '</div>';
  }

  // 原话区：这一章我到底怎么说的（传记的底色，AI 稿只是整理版）
  if (quotes.length) {
    html += '<div class="bk-source"><div class="bk-source-title">我当时说的话</div>';
    for (const q of quotes) {
      html += `<p class="bk-quote-line">${esc(q.text)}`;
      if (o.includeAudio && q.audioUrl) {
        html += `<audio controls preload="none" src="${esc(q.audioUrl)}"></audio>`;
      }
      html += '</p>';
    }
    html += '</div>';
  }
  html += '</section>';
  return html;
}

// 生成整本 HTML
// opts: { absoluteBase, style: 'warm'|'classic'|'ink', includeAudio, includeTimeline, intro, epilogue, narrator }
function buildBookHtml(data, opts) {
  const o = Object.assign({
    absoluteBase: '', style: 'warm', includeAudio: false,
    includeTimeline: true, intro: '', epilogue: '', narrator: '',
  }, opts || {});
  const p = data.person || {};
  const chapters = sortChapters(data.chapters || []).filter((c) => String(c.summary || '').trim() || String(c.excerpt || '').trim());
  const name = p.real_name || p.name || '无名';

  const withAbs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    return o.absoluteBase ? o.absoluteBase.replace(/\/$/, '') + u : u;
  };
  const chaptersData = chapters.map((c) => ({
    ...c,
    photos: (c.photos || []).map((x) => ({ ...x, url: withAbs(x.url) })),
    quotes: (c.quotes || []).map((x) => ({ ...x, audioUrl: withAbs(x.audioUrl) })),
  }));

  const tl = o.includeTimeline ? buildTimeline(chapters) : [];
  const born = p.birth_date ? `<div>生于 ${esc(p.birth_date)}</div>` : '';
  const home = p.birthplace ? `<div>籍贯 ${esc(p.birthplace)}</div>` : '';
  const died = p.death_date ? `<div>卒于 ${esc(p.death_date)}</div>` : '';

  const introText = o.intro
    || `这本书记下了 ${esc(name)} 一生讲过的故事。\n\n从儿时的老屋到如今的日子，一句句话，都是 TA 自己说的。我们只是把它们留了下来。`;
  const epiText = o.epilogue || '谨以此书，留给记得的人。';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(name)} 的一生</title>
<style>${bookCss(o.style)}</style>
</head>
<body class="bk">
<main class="bk-book">
  <section class="bk-cover">
    <div class="bk-cover-mark">${esc(String(name).charAt(0))}</div>
    <h1>${esc(name)} 的一生</h1>
    <div class="bk-cover-sub">口述实录</div>
    <div class="bk-cover-meta">${born}${home}${died}</div>
  </section>

  <section class="bk-sec">
    <h2 class="bk-sec-title">序</h2>
    <div class="bk-body-text">${esc(introText)}</div>
    ${o.narrator ? `<div class="bk-sign">${esc(o.narrator)} 记</div>` : ''}
  </section>

  ${chaptersData.map((c) => chapterHtml(c, { includeAudio: o.includeAudio })).join('\n')}

  ${tl.length ? `
  <section class="bk-sec">
    <h2 class="bk-sec-title">年表</h2>
    <div class="bk-timeline">
      ${tl.map((t) => `<div class="bk-tl-item"><span class="bk-tl-year">${esc(t.year)}</span><span class="bk-tl-text">${esc(t.title)}</span></div>`).join('\n      ')}
    </div>
  </section>` : ''}

  <section class="bk-sec">
    <h2 class="bk-sec-title">后记</h2>
    <div class="bk-body-text">${esc(epiText)}</div>
  </section>

  <section class="bk-end">
    <div class="bk-orn">☾</div>
    <p>共 ${chaptersData.length} 章</p>
  </section>
</main>
</body>
</html>`;
}

function bookCss(style) {
  const palettes = {
    warm: { paper: '#FAF7F0', ink: '#33302a', accent: '#8a6a3d', soft: '#f0e8da', line: '#e0d6c4' },
    classic: { paper: '#fbfaf7', ink: '#2a2a2a', accent: '#6b4c3b', soft: '#eee9e0', line: '#dcd5c8' },
    ink: { paper: '#f4f6f7', ink: '#1f2429', accent: '#3b5560', soft: '#e3e9ec', line: '#ccd6db' },
  };
  const p = palettes[style] || palettes.warm;
  return `
:root{--paper:${p.paper};--ink:${p.ink};--accent:${p.accent};--soft:${p.soft};--line:${p.line};}
*{box-sizing:border-box;margin:0;padding:0}
body.bk{background:#d9d2c6;color:var(--ink);
  font-family:"Songti SC","STSong","Noto Serif SC","Source Han Serif SC",serif;line-height:2}
.bk-book{max-width:720px;margin:0 auto;background:var(--paper);box-shadow:0 6px 32px rgba(0,0,0,.18)}
.bk section{padding:44px 42px;border-bottom:1px solid var(--line)}
.bk-cover{text-align:center;padding:96px 42px 76px;background:linear-gradient(170deg,var(--paper),var(--soft))}
.bk-cover-mark{width:60px;height:60px;margin:0 auto 20px;border:2px solid var(--accent);color:var(--accent);
  display:flex;align-items:center;justify-content:center;font-size:32px;border-radius:6px}
.bk-cover h1{font-size:38px;letter-spacing:.14em;color:var(--accent);font-weight:600}
.bk-cover-sub{margin-top:12px;font-size:15px;letter-spacing:.4em;color:var(--ink);opacity:.7}
.bk-cover-meta{margin-top:22px;font-size:14px;opacity:.75;line-height:2}
.bk-sec-title{font-size:22px;letter-spacing:.28em;text-align:center;color:var(--accent);margin-bottom:26px}
.bk-body-text{font-size:16px;line-height:2.15;text-align:justify;white-space:pre-line}
.bk-sign{margin-top:20px;text-align:right;font-size:14px;opacity:.7}
.bk-chapter-head{text-align:center;margin-bottom:24px}
.bk-chapter-head h2{font-size:25px;letter-spacing:.1em;color:var(--ink);line-height:1.5}
.bk-year{margin-top:8px;font-size:13px;letter-spacing:.2em;color:var(--accent)}
.bk-excerpt{margin:0 0 22px;padding:14px 18px;border-left:3px solid var(--accent);
  background:var(--soft);color:var(--ink);font-size:15.5px;line-height:1.95;font-style:normal}
.bk-photos{margin:22px 0;display:flex;flex-wrap:wrap;gap:14px}
.bk-photos figure{flex:0 0 46%;margin:0}
.bk-photos img{width:100%;max-height:300px;object-fit:cover;border-radius:6px;display:block}
.bk-photos figcaption{font-size:12.5px;opacity:.7;margin-top:6px;text-align:center}
.bk-source{margin-top:26px;padding-top:18px;border-top:1px dashed var(--line)}
.bk-source-title{font-size:13px;letter-spacing:.2em;color:var(--accent);margin-bottom:12px}
.bk-quote-line{font-size:14.5px;line-height:1.95;color:#4a453d;padding-left:12px;
  border-left:2px solid var(--line);margin-bottom:12px;white-space:pre-wrap}
.bk-quote-line audio{display:block;width:100%;max-width:300px;height:32px;margin-top:6px}
.bk-timeline .bk-tl-item{display:flex;gap:16px;padding:9px 0;border-bottom:1px dashed var(--line);align-items:baseline}
.bk-tl-year{flex:none;min-width:56px;text-align:right;color:var(--accent);font-size:17px}
.bk-tl-text{font-size:14.5px;line-height:1.85}
.bk-end{text-align:center;padding:70px 42px;background:linear-gradient(0deg,var(--paper),var(--soft));border-bottom:none}
.bk-orn{font-size:19px;color:var(--accent);opacity:.7;margin-bottom:12px}
.bk-end p{font-size:13px;letter-spacing:.2em;opacity:.65}
@media print{
  body.bk{background:#fff}
  .bk-book{max-width:none;box-shadow:none}
  .bk section{page-break-after:always;break-after:page;padding:52px 46px}
  .bk-cover{min-height:92vh;display:flex;flex-direction:column;justify-content:center}
  .bk-end{min-height:40vh;display:flex;flex-direction:column;justify-content:center}
  .bk-photos figure{flex:0 0 46%}
}
@media(max-width:560px){
  .bk section{padding:32px 22px}
  .bk-cover h1{font-size:30px}
  .bk-photos figure{flex:0 0 100%}
}`;
}

module.exports = { buildBookHtml, bookCss, esc, sortChapters, buildTimeline };
