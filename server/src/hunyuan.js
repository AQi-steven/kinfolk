// server/src/hunyuan.js
// 腾讯云原生混元 API（TC3-HMAC-SHA256 签名），用长期 SecretId/SecretKey 调用，
// 避免 OpenAI 兼容接口的 API Key 短期过期问题。
const https = require('https');
const crypto = require('crypto');

const SERVICE = 'hunyuan';
const HOST = 'hunyuan.ai.tencentcloudapi.com';
const DEFAULT_REGION = 'ap-guangzhou';
const DEFAULT_MODEL = 'hunyuan-lite';

function sha256(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toTencentMessages(messages) {
  // OpenAI 格式 {role, content} -> 混元 {Role, Content}
  return messages.map((m) => ({
    Role: m.role.charAt(0).toUpperCase() + m.role.slice(1),
    Content: String(m.content || ''),
  }));
}

function chatCompletion(messages, opts = {}) {
  const secretId = opts.secretId || process.env.LLM_SECRET_ID;
  const secretKey = opts.secretKey || process.env.LLM_SECRET_KEY;
  const model = opts.model || process.env.LLM_MODEL || DEFAULT_MODEL;
  const region = opts.region || process.env.LLM_REGION || DEFAULT_REGION;
  const signal = opts.signal || null; // 外部 AbortSignal，超时/取消时销毁底层请求
  const timeoutMs = opts.timeout || 30000; // 兜底超时，避免请求永久挂死

  if (!secretId || !secretKey) {
    return Promise.reject(new Error('缺少腾讯云 SecretId/SecretKey'));
  }

  const now = new Date();
  const date = formatDate(now);
  const timestamp = Math.floor(now.getTime() / 1000);

  const payload = JSON.stringify({
    Model: model,
    Messages: toTencentMessages(messages),
  });

  const payloadHash = sha256(payload);
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json\nhost:${HOST}\n`;
  const signedHeaders = 'content-type;host';

  const canonicalRequest = [
    httpRequestMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, SERVICE);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign).toString('hex');

  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const reqOpts = {
    hostname: HOST,
    port: 443,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Host': HOST,
      'X-TC-Action': 'ChatCompletions',
      'X-TC-Version': '2023-09-01',
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': region,
      'Authorization': authorization,
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const req = https.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.Response && json.Response.Error) {
            const err = json.Response.Error;
            return done(reject)(new Error(`TencentCloud Error ${err.Code}: ${err.Message}`));
          }
          // 统一包装成 OpenAI 兼容结构，让上层无感切换
          const choice = json.Response && json.Response.Choices && json.Response.Choices[0];
          const content = choice && choice.Message && choice.Message.Content;
          done(resolve)({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: content || '',
                },
              },
            ],
            // 保留原始响应，方便调试
            _raw: json.Response,
          });
        } catch (e) {
          done(reject)(new Error('解析混元响应失败: ' + (e.message || e)));
        }
      });
    });
    req.on('error', (err) => done(reject)(err));
    // 兜底超时：超时直接销毁 socket，避免请求永久挂死（混元 401/网络不可达时尤其必要）
    req.setTimeout(timeoutMs, () => {
      done(reject)(new Error('hunyuan-request-timeout-' + timeoutMs));
      req.destroy();
    });
    // 外部信号（上层 Promise.race 超时）：立刻销毁底层请求，停止占用配额
    if (signal) {
      if (signal.aborted) {
        done(reject)(new Error('hunyuan-request-aborted'));
        req.destroy();
      } else {
        const onAbort = () => {
          done(reject)(new Error('hunyuan-request-aborted'));
          req.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    req.write(payload);
    req.end();
  });
}

module.exports = { chatCompletion };
