/**
 * 服务端接口验证：经由本地 server.js 调用真实供应商
 * 覆盖：模型列表、连通性、上传、文生图、图生图(edit)、流式对话
 *
 * 用法（需要先启动 server.js）：
 *   API_BASE_URL=https://your-provider.example/v1 \
 *   API_KEY=sk-... API_MODEL=gpt-image-1 \
 *   node verify.js [all|models|test|upload|gen|edit|chat]
 *
 * 可选：IMG_PATH=/path/to/some.jpg 用于图生图测试。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const PROVIDER = {
  baseUrl: process.env.API_BASE_URL || '',
  apiKey: process.env.API_KEY || '',
  model: process.env.API_MODEL || 'gpt-image-1',
  authStyle: process.env.API_AUTH_STYLE || 'bearer',
};

if (!PROVIDER.baseUrl || !PROVIDER.apiKey) {
  console.log('SKIP  未设置 API_BASE_URL / API_KEY，跳过真实供应商验证');
  process.exit(0);
}

const which = process.argv[2] || 'all';
const log = (...a) => console.log(...a);

async function jpost(p, body, timeout = 900000) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 500) }; }
  return { status: r.status, j };
}

(async () => {
  if (which === 'all' || which === 'models') {
    const t0 = Date.now();
    const { status, j } = await jpost('/api/models', { provider: PROVIDER });
    log('MODELS', status, ((Date.now() - t0) / 1000).toFixed(1) + 's', (j.models || []).map(m => m.id).join(', ') || JSON.stringify(j).slice(0, 300));
  }

  if (which === 'all' || which === 'test') {
    const { status, j } = await jpost('/api/test', { provider: PROVIDER });
    log('TEST', status, JSON.stringify(j));
  }

  let uploadId = null;
  if (which === 'upload' || which === 'all' || which === 'edit') {
    // 图生图需要一个本地图片；没有提供就跳过上传环节
    const src = process.env.IMG_PATH || '';
    if (!src || !fs.existsSync(src)) {
      log('SKIP  未提供 IMG_PATH，跳过上传/图生图');
    } else {
      const buf = fs.readFileSync(src);
      const r = await fetch(BASE + '/api/upload', { method: 'POST', body: buf });
      const j = await r.json();
      uploadId = j.id;
      log('UPLOAD', r.status, j.bytes, j.id);
    }
  }

  if (which === 'gen' || which === 'all') {
    const t0 = Date.now();
    const { status, j } = await jpost('/api/images/generations', {
      provider: { ...PROVIDER },
      prompt: 'A single red ceramic coffee cup on a white table, soft morning light, product photo',
      params: { size: '1024x1024', n: 1 },
      images: [],
    });
    const item = (j.items || [])[0];
    const head = item ? Buffer.from(item.data, 'base64').subarray(0, 8).toString('hex') : '';
    log('GEN', status, ((Date.now() - t0) / 1000).toFixed(1) + 's', item ? `${item.type} ${Buffer.from(item.data || '', 'base64').length} bytes head=${head}` : JSON.stringify(j).slice(0, 400));
    if (item && item.data) fs.writeFileSync(path.resolve('verify_gen.png'), Buffer.from(item.data, 'base64'));
  }

  if (which === 'edit' || which === 'all') {
    const t0 = Date.now();
    const { status, j } = await jpost('/api/images/edits', {
      provider: PROVIDER,
      prompt: 'Turn this waving hand gesture into a thumbs up, keep everything else identical',
      params: { size: '1024x1024' },
      images: [{ uploadId, mime: 'image/gif', name: 'ref.gif' }],
    });
    const item = (j.items || [])[0];
    log('EDIT', status, ((Date.now() - t0) / 1000).toFixed(1) + 's',
      item ? `${item.type} ${Buffer.from(item.data || '', 'base64').length} bytes` : JSON.stringify(j).slice(0, 600));
    if (j.attempts) log('  fallback errors:', JSON.stringify(j.attempts).slice(0, 400));
    if (item && item.data) fs.writeFileSync(path.resolve('verify_edit.png'), Buffer.from(item.data, 'base64'));
  }

  if (which === 'chat' || which === 'all') {
    const t0 = Date.now();
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: { ...PROVIDER, model: process.env.CHAT_MODEL || 'gpt-4o-mini' },
        messages: [{ role: 'user', content: '用一句话描述一个适合画布的配色方案。' }],
        params: { temperature: 0.8 },
      }),
    });
    log('CHAT status', r.status, r.headers.get('content-type'));
    let text = '', reasoning = '', events = 0;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(block);
        const dt = /data: (.*)/s.exec(block);
        if (!dt) continue;
        events++;
        const d = JSON.parse(dt[1]);
        if (ev && ev[1] === 'delta') text += d.delta;
        if (ev && ev[1] === 'reasoning') reasoning += d.delta;
        if (ev && ev[1] === 'error') log('  chat error:', d.message);
        if (ev && ev[1] === 'done') log('  done event:', JSON.stringify(d).slice(0, 200));
      }
    }
    log('CHAT', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'events=' + events, 'textlen=' + text.length, 'reasoninglen=' + reasoning.length);
    log('  text:', text.slice(0, 200));
  }
})().catch((e) => { console.log('FATAL', e.message); process.exitCode = 1; });
