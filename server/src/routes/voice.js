// server/src/routes/voice.js — 服务端语音：TTS（合成）+ ASR（识别）
// 依赖腾讯云 SDK（TTS/ASR 同一账号 SecretId/Key）。未配置时接口返回明确错误，前端降级。
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

// 手动加载项目根目录 .env（本项目未引入 dotenv，这里显式解析，避免 .env 里的凭证不被加载）
(function loadEnvFile() {
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
    path.resolve('/path/to/cybio/.env'),
  ];
  for (const envPath of candidates) {
    try {
      if (fs.existsSync(envPath)) {
        const txt = fs.readFileSync(envPath, 'utf8');
        for (const line of txt.split('\n')) {
          const m = line.trim().match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
          if (m && (!(m[1] in process.env) || !process.env[m[1]])) {
            process.env[m[1]] = m[2].trim();
          }
        }
        break;
      }
    } catch (_) {}
  }
})();

const SECRET_ID = process.env.TENCENT_SECRET_ID || '';
const SECRET_KEY = process.env.TENCENT_SECRET_KEY || '';
const REGION = process.env.TENCENT_REGION || 'ap-guangzhou';

const TTS_DIR = path.join(__dirname, '..', '..', 'data', 'tts');
try { fs.mkdirSync(TTS_DIR, { recursive: true }); } catch (_) {}

function tencentClients() {
  if (!SECRET_ID || !SECRET_KEY) return null;
  const tencentcloud = require('tencentcloud-sdk-nodejs');
  const tts = new tencentcloud.tts.v20190823.Client({
    credential: { secretId: SECRET_ID, secretKey: SECRET_KEY },
    region: REGION, profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com' } },
  });
  const asr = new tencentcloud.asr.v20190614.Client({
    credential: { secretId: SECRET_ID, secretKey: SECRET_KEY },
    region: REGION, profile: { httpProfile: { endpoint: 'asr.tencentcloudapi.com' } },
  });
  return { tts, asr };
}

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

// TTS 缓存文件数上限：超出后按修改时间删除最旧的，防止磁盘无限膨胀（P2 健壮性）
const MAX_TTS_FILES = 500;
function pruneTtsCache() {
  try {
    const files = fs.readdirSync(TTS_DIR).filter((f) => /\.mp3$/.test(f));
    if (files.length <= MAX_TTS_FILES) return;
    const withMtime = files
      .map((f) => ({ f, m: fs.statSync(path.join(TTS_DIR, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    const excess = files.length - MAX_TTS_FILES;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(TTS_DIR, withMtime[i].f)); } catch (_) {}
    }
  } catch (_) {}
}

// ===== TTS：合成 AI 文本为音频 =====
// GET /api/tts?text=...&voice=...  → 返回 { url } 或 { error }
// 语音接口按量计费（腾讯云 TTS 配额），必须登录后才能调用，防止匿名刷配额
router.get('/tts', authMiddleware, async (req, res) => {
  const text = (req.query.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: '缺少文本' });
  if (text.length > 150) return res.status(400).json({ error: '单次合成文本过长（≤150字）' });
  const clients = tencentClients();
  if (!clients) return res.status(503).json({ error: '语音合成未配置（缺少腾讯云密钥）' });

  // 缓存：相同文本+音色复用
  // 默认音色：101007「温柔女声」（Neural 高阶，更自然温暖，适合长辈陪伴场景）
  const voiceType = (req.query.voice || '101007').toString();
  const cacheKey = sha1(voiceType + '|' + text);
  const mp3Name = cacheKey + '.mp3';
  const mp3Path = path.join(TTS_DIR, mp3Name);
  if (fs.existsSync(mp3Path)) {
    return res.json({ url: '/api/tts-file/' + mp3Name });
  }
  try {
    const resp = await clients.tts.TextToVoice({
      Text: text,
      SessionId: cacheKey.slice(0, 16),
      VoiceType: Number(voiceType),
      Volume: 5,
      Speed: 0,
      ProjectId: 0,
      ModelType: 1, // 高阶 Neural 音色，更自然
    });
    if (resp.Audio === undefined || resp.Audio === null) {
      return res.status(502).json({ error: 'TTS 返回为空：' + (resp.Error || {}).Message });
    }
    fs.writeFileSync(mp3Path, Buffer.from(resp.Audio, 'base64'));
    pruneTtsCache();
    return res.json({ url: '/api/tts-file/' + mp3Name });
  } catch (e) {
    return res.status(502).json({ error: 'TTS 合成失败：' + (e.message || e) });
  }
});

// 静态托管合成好的 mp3
router.get('/tts-file/:name', (req, res) => {
  const name = (req.params.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
  const p = path.join(TTS_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=31536000');
  fs.createReadStream(p).pipe(res);
});

// ===== ASR：识别上传的 WAV 音频（16k, 单声道 PCM WAV）=====
// POST /api/asr  body: raw bytes (application/octet-stream)  → { text, audio_id }
// 语音接口按量计费（腾讯云 ASR 配额），必须登录后才能调用，防止匿名刷配额
//
// 2026-10-04 新增：识别的同时**把原始音频落盘留存**（原音追溯）。
//   动机：AI 转写会错，而传记里"这个人当时到底怎么说的"应以真人为准。
//   前端通过 query 传 interview_id；消息 id 由前端在识别成功后随 message 一起回写关联。
//   留存失败绝不影响识别结果（传记正文不能因为存音频失败而丢内容）。
function saveAudioClip(buf, { interviewId, durationMs }) {
  try {
    const iid = interviewId ? +interviewId : null;
    if (!iid) return null;
    // 只允许本人/自己发起的访谈，防止随意往他人访谈塞音频
    const iv = db.prepare('SELECT id FROM interviews WHERE id = ? AND user_id = ?').get(iid, req.user.id);
    if (!iv) return null;
    const dir = path.join(__dirname, '..', '..', '..', 'web', 'uploads', 'audio');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fname = `a_${iid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.wav`;
    fs.writeFileSync(path.join(dir, fname), buf);
    const info = db.prepare(
      'INSERT INTO audio_clips(interview_id, file, mime, duration_ms, size_bytes) VALUES(?, ?, ?, ?, ?)'
    ).run(iid, 'audio/' + fname, 'audio/wav', Math.max(0, +durationMs || 0), buf.length);
    return Number(info.lastInsertRowid);
  } catch (e) {
    console.warn('[asr] 原始音频留存失败（不影响识别结果）:', e.message);
    return null;
  }
}

router.post('/asr', authMiddleware, (req, res) => {
  const clients = tencentClients();
  if (!clients) return res.status(503).json({ error: '语音识别未配置（缺少腾讯云密钥）' });
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) return res.status(400).json({ error: '空音频' });
    try {
      const resp = await clients.asr.SentenceRecognition({
        ProjectId: 0,
        SubServiceType: 2, // 一句话识别
        EngSerViceType: '16k_zh',
        SourceType: 1, // 语音数据直接上传
        VoiceFormat: 'wav', // 必须为字符串：wav / mp3 / pcm ...
        Data: buf.toString('base64'),
        DataLen: buf.length,
      });
      // ⚠️ 修复（2026-09-13）：区分「识别成功但没听清」与「调用失败」。
      //   腾讯云 SentenceRecognition 在**音频有效但无有效语音**（静音/太轻/太短）时，
      //   返回 200 + `Result: ""` + `AudioDuration` —— 这是**正常成功**，不是错误。
      //   原代码用 `if (resp.Result || resp.AudioUrl)` 判断，空字符串落进 else 分支
      //   返回 502「ASR 无结果」，导致前端「按住说话」松开后总是报错。
      //   现改为：只要拿到了 AudioDuration（或显式 Result 字段）即视为识别成功，
      //   空文本原样返回，由前端提示「没听清，再说一次」。
      const recognized = (resp.Result !== undefined && resp.Result !== null)
        || resp.AudioDuration !== undefined
        || resp.AudioUrl !== undefined;
      if (recognized) {
        const durMs = resp.AudioDuration || 0;
        // 原音留存：只有真正识别出内容才值得留（静音/没听清的片段没有价值）
        const audioId = resp.Result && String(resp.Result).trim()
          ? saveAudioClip(buf, { interviewId: req.query.interview_id, durationMs: durMs })
          : null;
        return res.json({ text: resp.Result || '', duration: durMs, audio_id: audioId });
      }
      return res.status(502).json({ error: 'ASR 无结果：' + ((resp.Error || {}).Message || '') });
    } catch (e) {
      return res.status(502).json({ error: 'ASR 识别失败：' + (e.message || e) });
    }
  });
});

module.exports = router;
