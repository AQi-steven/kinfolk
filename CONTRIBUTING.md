# 贡献指南

感谢你愿意花时间看这个项目。这份文档记录了**几条踩过坑才定下的铁律**，
它们不在代码注释里，但在动手前必须知道。

---

## 铁律（改动前必读）

### 1. 章节正文是不可再生的资产

`memoir_chapters.summary` 是老人一生只讲一次的东西。**任何覆盖都必须先留痕。**

改动正文的每一条路径，都必须在写入前调用：

```js
const history = require('../chapter-history');
history.snapshotChapter(chapterId, userId, 'source', '说明文字');
```

已接入留痕的路径（新增时请照做）：

| 路径 | source |
|---|---|
| 本人手工编辑（PATCH /chapters/:cid） | `edit` |
| 补讲融合（POST /chapters/:cid/extend） | `ai_extend` |
| 接着聊融合（`sedimentIntoFocusChapter`） | `ai_extend` |
| 家人建议采纳（`suggestions` adopt） | `suggestion` |
| 回滚自身（回滚前自动存档） | `restore` |

**漏一处就漏一次数据丢失。** 修改前建议先 `grep -rn "UPDATE memoir_chapters"` 摸清全量。

### 2. 原话与原音任何情况不改

`messages.content`（原话）与 `audio_clips`（原音）是「这个人真的这么说过」的证据。

- ✅ 本人可以**订正识别文字**（ASR 会听错地名人名）
- ✅ 订正前原文入 `corrections_audit` 留痕，只增不改不删
- ❌ 任何情况下**不得修改或删除音频**
- ❌ 不得因任何理由自动改写原话

### 3. 家人只能提交建议

`suggestions.js` 文件头的权限铁律不可放宽：

1. 家人**只能提交建议**，永远不能直接改正文
2. 只有节点本人能查看建议、采纳或驳回
3. 采纳只改章节正文，**原话与原音一律不动**

### 4. 成书与版本历史仅本人可操作

`GET /memoir/persons/:id/book`（成书）汇总全部章节，
而逐章 `visibility` 是分级的，汇总后无法再按章区分 —— **必须在导出入口统一收口**。

### 5. SQL 字符串一律用单引号

项目用 `node:sqlite`，**双引号会被当作标识符**，报 `no such column`。
反例：`IFNULL(summary,"")` ✗ → `IFNULL(summary,'')` ✓

### 6. 备份必须用 VACUUM INTO

不能用 `cp` 备份 SQLite，且目标文件须不存在。

```js
db.exec(`VACUUM INTO '${target}'`);
```

### 7. 新增规则优先写成「禁止型」

要求模型「多用体感细节」会诱导它**编造细节**。
要写成「不要用套话成语，并且只从用户已经讲过的细节里取材」。

**宁可平淡，也不能掺假。**

### 8. 改样式只动 `web/css/styles.css`

`styles.css` 是唯一主样式源。`_tw.css` 已退化为基础/主题令牌层。

---

## 环境

- **Node.js ≥ 22**（必须，用到内置 `node:sqlite`）
- 启动需带 `--experimental-sqlite`

```bash
npm install
node --experimental-sqlite server/index.js
```

未配置模型密钥会自动进入**演示模式**，全流程可跑通，适合开发调试。

复制 `.env.example` 为 `.env` 并按需填写。

---

## 提交前自查

```bash
# 语法
node --check server/src/your-file.js

# 回归测试（应全过）
node test/extract-rules.test.js
node test/extractor.test.js
node test/ingest-guard.test.js

# 若改动了隐私相关内容，复跑脱敏检查
python3 sanitize.py --check
```

---

## 提问与讨论

遇到设计上的疑问，欢迎开 issue 讨论。这个项目没有隐藏的正确用法，
很多决定都是在真实使用中被迫改出来的。

如果你也在为家里某个人做口述记录，欢迎分享你的场景 ——
不同家庭的情况差异很大，可能需要完全不同的引导方式。
