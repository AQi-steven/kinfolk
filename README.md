# Kinfolk · 一生之记

<div align="center">

**[English](#english) · [中文](#中文)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-green.svg)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/SQLite-node%3A%3Asqlite-blue.svg)](https://nodejs.org/api/sqlite.html)
[![零构建 / Zero-build](https://img.shields.io/badge/build-zero--build-brightgreen.svg)](https://vitejs.dev)

</div>

---

# 中文

> **Kinfolk** = kin（亲缘）+ folk（众人与口述传统）。中文名「一生之记」。

> 手机端 AI 访谈式**个人传记**：AI 扮「老朋友」听一个人讲一生，后台静默抽取人物与关系，
> 自动沉淀成回忆录。
> **传记是第一性的，家谱是从访谈里长出来的** —— 你讲你父亲，他讲他的父亲，
> 散落的口述自然连成一份家族脉络，没有人需要手动画族谱。

## 这是什么

给不会打字、视力下降、说话带着浓重口音的**老一辈**做的口述传记工具。

老人只需要**说话**。剩下的交给 AI：把语音转成文字、追问细节、抽出人物与关系、
整理成章节，最后导出一本可以打印、可以转发给子女的书。

**核心假设：当事人只需要说话，文字的事交给 AI。**
所以产品的一切设计都围绕「让老人愿意多讲一句」。

而当家里每个人都这样讲一遍，**家族关系图自然浮现**——
爷爷是谁、外公和外婆怎么认识的、谁和谁是同门，
这些原本散在各人嘴里的碎片，会自己连成谱系。

## 特性

### 访谈引擎

- **语音优先**：按住说话，松开即发，ASR 服务端识别，老人不需要打字
- **AI 追问**：像老朋友一样顺着上一句往下问，不做清单式盘问
- **反 AI 腔**：显式禁用套话成语（波澜壮阔 / 岁月如歌）与文艺腔套板，
  并给出可执行替代（写「想念」→ 写「她总把收音机音量拧到最小」）
- **人生骨架提问**：童年 / 故乡 / 求学 / 谋生 / 成家 / 闯荡 / 日常 / 寄语 八段，
  已聊过的段落自动避开，不反复追问
- **跨访谈记忆**：已采集字段、已聊话题持久化，跨设备跨时间不再重问
- **护栏分级**：硬违规（编造事实）确定性纠正；软违规（重复/跳跃）优先让模型
  重写问句，而不是直接丢弃自然回复

### 传记沉淀

- **自动成章**：每 5 轮或用户示意结束，自动生成第一人称回忆录正文
- **原话原音追溯**：每一章都能展开「我当时说的话」，有录音的逐句可回听
  - 原话与原音是「真的这么说过」的证据，任何情况不改；只允许订正识别文字
- **正文版本历史**：每一次正文覆盖（人改 / AI 融合 / 家人采纳）都留快照，
  改错了能一字不差地退回去，**回滚本身也可回滚**
- **成书出口**：整本 HTML，可打印存 PDF，可下载转发给家人

### 关系与家谱

- **家谱从访谈里长出来**：不需要任何人手动画族谱。每个长辈讲自己的一生时，
  AI 抽出的亲属边（父母 / 子女 / 配偶）自动把一家人连起来 —— 
  爷爷是谁、外公外婆怎么认识的、谁和谁同门，这些碎片自己会拼成谱系
- **世代分层遍历**：关系图接口按 `depth` 分层展开（本人 → 父母 → 祖辈 / 子女），
  同一份数据也可按姓氏、按分支聚合
- **同名自动合并**：两处出现"同名 + 同关系角色"时（如两人都提到"舅舅李强"），
  触发三问题验证再合并，避免重复节点把谱系撑乱
- **人物线视图**：把某人提到过的所有重要人物归集成"我的亲属 / 重要他人"，
  可对任意一人单独补讲故事
- **照片破冰**：老人翻出老照片，AI 据此问出照片里那件具体的事
- **家人补充**：家人只能提交建议，**由本人确认后才入正文**，永不能直接改写
- **隐私分级**：人物与章节均可设 `public` / `family` / `self`

> **当前完成度**：关系数据与分层遍历已跑通，界面为分层列表；
> **图形化谱系图（按世代排布的图）尚在规划中**。

### 工程

- **零构建**：前端原生 JS，无打包步骤，改完刷新即生效
- **零原生依赖**：`node:sqlite`（Node 22 内置）+ 自写鉴权（JWT + scrypt）
- **离线可用**：无模型密钥时自动进入演示模式，全流程可跑通
- **单文件数据库**：SQLite，备份即复制

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 22 | 必须，用到内置 `node:sqlite` |
| 后端 | Express | 零中间件依赖 |
| 数据库 | `node:sqlite` | Node 22 内置，无原生编译 |
| 鉴权 | 自写 JWT（HS256）+ scrypt | 纯 `node:crypto` |
| AI | OpenAI 兼容接口 | 可接任意兼容网关 |
| 语音 | 腾讯云 ASR / TTS | 或任何兼容服务 |
| 前端 | 原生 JS SPA | 哈希路由，零构建 |

## 快速开始

**环境要求**：Node.js ≥ 22（必须）

```bash
npm install
node --experimental-sqlite server/index.js
# 或
bash start.sh
```

打开 `http://localhost:4000`。

> **未配置大模型密钥时会自动进入演示模式** —— 访谈走脚本化离线回复，
> 全流程照样能跑通，配上密钥即接真实模型。

### 配置大模型（可选）

密钥取值链：**环境变量 → 密钥文件 → settings 表 → 随机**（绝不硬编码）。

| 变量 | 说明 |
|---|---|
| `LLM_API_KEY` | OpenAI 兼容接口的密钥 |
| `LLM_BASE_URL` | 接口地址 |
| `LLM_MODEL` | 模型名 |
| `JWT_SECRET_FILE` | JWT 密钥文件路径 |

### 配置语音（可选）

TTS / ASR 需要腾讯云凭据：`TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`。
未配置时语音功能降级，其余功能不受影响。详见 `.env.example`。

## 项目结构

```
server/
  index.js                 Express 入口
  src/
    db.js                  SQLite 初始化 + 幂等建表
    auth.js                JWT + scrypt + 账号锁定
    llm.js                 访谈引擎（倾听者提示词 / 护栏 / 章节生成）
    extractor.js           事实抽取（与对话解耦）
    extract-rules.js       抽取硬闸门（确定性拦截）
    ingest-guard.js        入库前终审
    interview.js           访谈会话引擎 + 章节沉淀
    chapter-history.js     正文版本快照与回滚
    bookgen.js             成书引擎（纯函数）
    routes/                auth / persons / egotree / interview / memoir /
                           media / suggestions / invitations / claims / voice
web/
  index.html               SPA 外壳
  js/                      store / api / ui / app
  js/pages/                home / lifebook / figures / interview /
                           person-edit / settings / inbox / verify / photo-icebreak
  css/styles.css           唯一主样式源
test/                      单元测试
docs/                      方法论文档
sanitize.py                脱敏脚本（开源用）
test_sanitize.py           脱敏规则自检
```

## 设计取舍

几个不那么显然、但很重要的决定：

**1. AI 一定会写错，所以先给安全网**
每一次正文覆盖都留快照，可回滚。在打磨「让 AI 写得好」之前，
先保证「写坏了能救回来」——这比技巧重要。

**2. 护栏不该让 AI 变笨**
早期护栏一命中就把模型的好回复整段替换成预设模板，结果是「像机器人」。
现在改为分级：硬违规确定性纠正，软违规优先让模型自己重写问句，失败才兜底。

**3. 新增规则一律是「禁止型」而非「要求型」**
要求「多用体感细节」会诱导模型编造细节；写成「不要用套话成语，
并只从用户已讲过的细节里取材」才安全。**宁可平淡，也不能掺假。**

**4. 家人只能提建议，不能改正文**
子女的记述可能无声覆盖父亲的自述。传记主语是讲述者本人，
谁有权定稿必须是他。

**5. 不引入不必要的构建链**
目标机器内存紧张，零构建的原生 SPA + 单文件 SQLite 是更稳的选择。

## 安全

- 所有写接口经 `authMiddleware`（或 `adminOnly`）
- JWT 用 HS256 + 恒定时间比较；密码用 scrypt 加盐哈希
- 登录失败按账号锁定（8 次 / 30 分钟 → 锁 15 分钟）+ IP 限速
- 密钥四级取值链，绝不硬编码、绝不入库
- 本仓库已移除全部真实姓名、手机号、服务器地址、内部路径与界面截图
  （脱敏脚本见 `sanitize.py`，自检见 `test_sanitize.py`，均可复跑）

## 开发

```bash
node --experimental-sqlite server/index.js   # 启动
npm run lint                                # 类型/语法检查
python3 test_sanitize.py --scan             # 隐私自检
```

**改动前请读 [CONTRIBUTING.md](CONTRIBUTING.md)**，
那里记录了几条踩过坑才定下的铁律。

## 许可

[MIT](LICENSE)

## 致谢

这个项目的原型想法来自一件很朴素的事：很多老人一生故事丰富，
但没有人耐心地问他们，于是那些故事就散了。

如果你也在为家里某个人做这件事，希望这个工具能帮上一点忙。

### 致 GitHub 上的开源贡献者

这个项目站在许多开源项目的工作之上。读源码、看别人怎么解决自己遇到过的坑，
是学技术最快的方式之一。**感谢 GitHub 上那些愿意分享代码、写下踩坑记录、
公开自己失败经历的人** —— 正是这些公开的分享，让一个想法变成了可以跑起来的程序。

也**特别感谢那些指出问题、提出建议的人**。开源的价值不止于代码本身，
更在于不同视角带来的修正。

如果你也在做类似的事，欢迎开 issue 交流。**我们尤其想听到这些方面的意见**：

- **适老化**：字多大、按钮怎么放、语音流程哪一步会卡住老人
- **提问方式**：什么样的问题老人愿意答、什么会让他们沉默
- **隐私边界**：亲人应该看到多少、哪些内容不该被子女读到
- **方言与口音**：如果你在做方言语音识别，我们的踩坑经验可能对你有用

坦白说，我们只是**站在别人的肩膀上**。这个项目想解决的是同一个问题：
怎么让老人的一生被问出来、被留下来。

---

<a name="english"></a>

# English

> An AI-powered, voice-first **oral biography** app: the AI listens like an old friend while
> someone tells the story of their life, quietly extracting people and relationships in the
> background, and settling those conversations into memoir chapters.
> **Biographies come first; the family tree grows out of them.** You record your father,
> he records his father — and scattered recollections quietly join into one family history.
> Nobody has to draw a family tree by hand.

## What it is

A memoir tool built for **elderly people** — those who can't type easily, whose eyesight has
faded, or whose speech carries a heavy regional accent.

They only need to **talk**. Everything else is the AI's job: transcribing speech, asking
follow-up questions, extracting people and relationships, turning it all into chapters, and
finally exporting a book you can print or forward to your children.

**The core assumption: the subject only has to speak. The writing is the AI's job.**
Every design decision follows from that — around one goal: *getting the elder to say one
more sentence.*

And when everyone in the family does this, **a family tree surfaces on its own** —
who the grandparents were, how they met, which cousins share a grandfather.
Fragments that used to live in separate mouths assemble themselves into a lineage.

## Features

### Interview engine

- **Voice first** — hold to talk, release to send; server-side ASR, no typing required
- **Natural follow-ups** — picks up on what was just said instead of reading from a checklist
- **Anti-AI-slop** — explicitly bans clichés (波澜壮阔 / 岁月如歌) and literary-sounding
  padding, and offers concrete alternatives (*"missing her"* → *"she always turned the radio
  volume all the way down, afraid of bothering the neighbours"*)
- **Life-spine questions** — eight stages (childhood / hometown / study / work / marriage /
  journey / daily life / legacy). Already-covered stages are skipped, so nothing is asked twice
- **Cross-session memory** — collected fields and covered topics persist across devices and time
- **Graded guardrails** — factual violations are corrected deterministically; softer ones
  (repetition, topic drift) first give the model a chance to *rewrite the question itself*
  rather than throwing away a good answer

### Memoir

- **Auto-chaptering** — a first-person memoir chapter every 5 turns, or when the user signals completion
- **Verbatim trace** — every chapter can expand into "what I actually said", with audio
  playable sentence by sentence
  - Verbatim text and original audio are evidence of *what was really said*, and are never
    modified. Only recognition typos may be corrected.
- **Version history** — every overwrite of a chapter (manual edit / AI merge / family
  contribution) is snapshotted, and any mistake can be rolled back verbatim —
  **the rollback itself is also reversible**
- **Book export** — a full HTML book, printable to PDF, downloadable and shareable

### Family history

- **A family tree that grows itself** — nobody draws one by hand. As each elder tells their
  own story, the kinship edges the AI extracts (parents / children / spouses) connect the
  family on their own: who the grandparents were, how they met, which cousins share an
  ancestor. Fragments assemble themselves into a lineage.
- **Generation-aware traversal** — the relationship endpoint expands in `depth` layers
  (self → parents → grandparents / children), and the same data can be grouped by surname
  or by branch.
- **Automatic merging of duplicates** — when the same "name + role" shows up twice
  (e.g. two people both mention "uncle Li Qiang"), a three-question verification runs
  before merging, so the lineage doesn't get polluted with duplicate nodes.
- **Figures view** — everyone a person has mentioned, grouped into "my relatives" and
  "other important people", each of whom can be interviewed on their own.
- **Photo icebreaker** — an old photo gives the AI something concrete to ask about
- **Family contributions** — relatives may only *submit suggestions*; only the subject decides
  whether they enter the memoir
- **Granular privacy** — people and chapters can be `public` / `family` / `self`

> **Current status**: the relationship data and generation traversal are working; the UI is a
> layered list. **A drawn-out graphical genealogy is still on the roadmap.**

### Engineering

- **Zero build step** — vanilla JS SPA; edit and refresh
- **No native dependencies** — `node:sqlite` (built into Node 22) + hand-rolled auth (JWT + scrypt)
- **Works offline** — without an API key it falls back to a demo mode where the whole flow still runs
- **Single-file database** — SQLite; a backup is a file copy

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js ≥ 22 | required, for built-in `node:sqlite` |
| Backend | Express | zero middleware |
| Database | `node:sqlite` | built in, nothing to compile |
| Auth | hand-rolled JWT (HS256) + scrypt | pure `node:crypto` |
| AI | any OpenAI-compatible endpoint | gateway-agnostic |
| Speech | Tencent Cloud ASR / TTS | or any compatible service |
| Frontend | vanilla JS SPA | hash routing, zero build |

## Quick start

**Requires Node.js ≥ 22**

```bash
npm install
node --experimental-sqlite server/index.js
# or
bash start.sh
```

Open `http://localhost:4000`.

> **Without an API key the app starts in demo mode** — the interview falls back to scripted
> offline replies and the entire flow still works end to end. Add a key to go live.

### LLM configuration (optional)

Secrets are resolved in a fixed chain: **env var → secret file → settings table → random**.
Never hard-coded.

| Variable | Purpose |
|---|---|
| `LLM_API_KEY` | API key for an OpenAI-compatible endpoint |
| `LLM_BASE_URL` | Endpoint base URL |
| `LLM_MODEL` | Model name |
| `JWT_SECRET_FILE` | Path to the JWT secret file |

### Speech configuration (optional)

TTS / ASR need Tencent Cloud credentials: `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`.
Without them, speech degrades gracefully; everything else keeps working.
See `.env.example`.

## Project layout

```
server/
  index.js                 Express entry
  src/
    db.js                  SQLite bootstrap + idempotent migrations
    auth.js                JWT + scrypt + account lockout
    llm.js                 interview engine (listener prompt / guardrails / chapters)
    extractor.js           fact extraction (decoupled from dialogue)
    extract-rules.js       deterministic extraction gates
    ingest-guard.js        final check before persisting
    interview.js           session engine + chapter sedimentation
    chapter-history.js     chapter snapshots & rollback
    bookgen.js             book generator (pure function)
    routes/                auth / persons / egotree / interview / memoir /
                           media / suggestions / invitations / claims / voice
web/
  index.html               SPA shell
  js/                      store / api / ui / app
  js/pages/                home / lifebook / figures / interview /
                           person-edit / settings / inbox / verify / photo-icebreak
  css/styles.css           the single source of truth for styles
test/                      unit tests
docs/                      methodology notes
sanitize.py                redaction script (for public release)
test_sanitize.py           redaction self-check
```

## Design trade-offs

A few decisions that aren't obvious but matter:

**1. The AI *will* write badly — so build the safety net first**
Every chapter overwrite is snapshotted and reversible. Before polishing *how well* the AI
writes, we made sure *a bad chapter can be rescued*. That matters more than technique.

**2. Guardrails shouldn't make the AI stupid**
The original guardrail replaced a good answer with a canned template the moment it tripped —
which is exactly why it felt robotic. Now: factual errors are corrected deterministically,
softer ones first let the model rewrite its own question.

**3. New rules should be written as prohibitions, not requirements**
Asking for "more sensory detail" invites the model to *invent* detail. Writing "no clichés,
and only draw from details the user already gave" is what is actually safe.
**Plain beats fake.**

**4. Family can suggest, never rewrite**
A child's account could silently overwrite the father's own words. The subject is the
protagonist — only they get to decide the final text.

**5. No build chain unless it's needed**
The target machine is memory-constrained; a zero-build SPA plus a single-file SQLite is the
sturdier choice.

## Security

- All write endpoints pass through `authMiddleware` (or `adminOnly`)
- JWT verified with HS256 + constant-time comparison; passwords hashed with scrypt + per-user salt
- Account lockout on repeated failures (8 attempts / 30 min → 15 min lock) plus IP rate limiting
- Secrets resolved by a four-step chain; never hard-coded, never stored in the DB
- This repository has had all real names, phone numbers, server addresses, internal paths and
  UI screenshots removed (`sanitize.py`, self-checked by `test_sanitize.py`; both re-runnable)

## Contributing

```bash
node --experimental-sqlite server/index.js   # run
npm run lint                                # lint
python3 test_sanitize.py --scan             # privacy self-check
```

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything** — it records a few iron
rules that were only written down after they were learned the hard way.

## License

[MIT](LICENSE)

## Acknowledgements

This project started from a plain observation: many elders have rich, remarkable lives, but
nobody sat down long enough to ask — and so the stories scattered.

If you're doing the same for someone in your family, I hope this helps a little.

### To open-source contributors on GitHub

This project stands on the work of many open-source projects. Reading other people's source
code and seeing how they solved the problems you also ran into is one of the fastest ways to
learn. **Thank you to everyone on GitHub who shares code, writes up the traps they hit, and
is willing to publish their failures** — it is precisely that openness that turned an idea
into a program that actually runs.

And a special **thank you to those who pointed out problems and offered suggestions**. The
value of open source isn't the code alone — it's the corrections that come from other
perspectives.

If you're working on something similar, please open an issue. **We'd especially like your
thoughts on:**

- **Accessibility for elders** — how large the text should be, where buttons belong, and which
  step of the voice flow tends to trip people up
- **Question design** — what makes an elder want to answer, and what makes them go quiet
- **Privacy boundaries** — how much should relatives see, and what should never be readable by
  children
- **Dialects and accents** — if you work on dialect speech recognition, our hard-won lessons
  may save you some time

Honestly, we were only **standing on other people's shoulders**. This project is trying to
solve the problem they are solving too: how to get a life asked for, and then kept.
