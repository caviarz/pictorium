#!/usr/bin/env node
/**
 * Imagium — 零依赖 Node 服务端
 *
 * 职责：
 *  1. 托管 public/ 下的静态前端
 *  2. 代理任意 OpenAI 兼容供应商（绕过浏览器 CORS）
 *  3. SSE 流式转发对话（有思考/无思考都兼容）
 *  4. 大体积参考图通过临时文件通道上传，避免 stdin/参数长度限制
 *
 * 供应商配置存在调用方浏览器 localStorage，每次请求随 body 带给服务端，
 * 服务端不落盘任何 key。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 400 * 1024 * 1024; // 400MB，容纳高清参考图
// 上传暂存目录。用项目名做前缀便于识别；旧版本留下的 ai-canvas-uploads 启动时顺手清掉。
const UPLOAD_DIR = path.join(os.tmpdir(), 'imagium-uploads');
const LEGACY_UPLOAD_DIR = path.join(os.tmpdir(), 'ai-canvas-uploads');
const DEFAULT_TIMEOUT = 15 * 60 * 1000; // 生成动图/大图可能很慢

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// 清理旧版本（项目曾用名）遗留的临时上传文件
try { fs.rmSync(LEGACY_UPLOAD_DIR, { recursive: true, force: true }); } catch { /* 可选清理 */ }

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, code, message, extra) {
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  json(res, code, { error: { message: String(message || 'unknown error'), ...(extra || {}) } });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大（上限 400MB）'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

/** 宽松拼接 base url 与路径：支持带/不带 /v1、结尾斜杠、完整 endpoint */
function joinUrl(base, endpoint) {
  let b = String(base || '').trim();
  if (!b) throw Object.assign(new Error('未配置供应商 Base URL'), { status: 400 });
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/+$/, '');
  const ep = endpoint.replace(/^\/+/, '');
  if (b.toLowerCase().endsWith('/' + ep.toLowerCase())) return b;
  return b + '/' + ep;
}

function authHeaders(cfg) {
  const h = {};
  const key = cfg.apiKey;
  if (key) {
    const style = cfg.authStyle || 'bearer';
    if (style === 'bearer') h['Authorization'] = 'Bearer ' + key;
    else if (style === 'x-api-key') h['x-api-key'] = key;
    else if (style === 'both') {
      h['Authorization'] = 'Bearer ' + key;
      h['x-api-key'] = key;
    }
  }
  for (const [k, v] of Object.entries(cfg.headers || {})) {
    if (k && v) h[k] = String(v);
  }
  return h;
}

/**
 * 统一发请求。返回 { status, headers, stream } 原始响应，由上层决定如何消费。
 * 重定向跟随 3 次。
 */
function upstreamRequest({ url, method, headers, body, signal, redirectLeft = 3 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(Object.assign(new Error('Base URL 不合法: ' + url), { status: 400 })); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: method || 'GET',
        headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
        timeout: 0,
      },
      (res) => {
        const sc = res.statusCode || 0;
        if (sc >= 300 && sc < 400 && res.headers.location && redirectLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(upstreamRequest({ url: next, method, headers, body, signal, redirectLeft: redirectLeft - 1 }));
          return;
        }
        resolve({ status: sc, headers: res.headers, stream: res });
      }
    );
    req.on('error', (e) => reject(Object.assign(new Error('连接上游失败: ' + e.message), { status: 502 })));
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('客户端已取消'), { aborted: true })), { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

function collect(stream, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('上游响应过大')); stream.destroy(); return; }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** 把上游错误响应体转成人类可读消息 */
async function describeUpstreamError(resp) {
  let text = '';
  try { text = (await collect(resp.stream, 2 * 1024 * 1024)).toString('utf8'); } catch { /* ignore */ }
  let message = text.trim().slice(0, 2000);
  try {
    const j = JSON.parse(text);
    message =
      (j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) ||
      j.message ||
      j.detail ||
      message;
  } catch { /* 保持原始文本 */ }
  return `HTTP ${resp.status}${message ? ' — ' + message : ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 上传临时文件清理                                                    */
/* ------------------------------------------------------------------ */

async function sweepUploads() {
  try {
    const files = await fsp.readdir(UPLOAD_DIR);
    const now = Date.now();
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f);
      try {
        const st = await fsp.stat(p);
        if (now - st.mtimeMs > 6 * 3600 * 1000) await fsp.unlink(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
sweepUploads();
setInterval(sweepUploads, 3600 * 1000).unref();

const UPLOAD_ID = /^[a-f0-9]{32}$/;

/* ------------------------------------------------------------------ */
/* 路由：/api/models                                                   */
/* ------------------------------------------------------------------ */

async function handleModels(req, res) {
  const body = await readJsonBody(req);
  const cfg = body.provider || {};
  const url = joinUrl(cfg.baseUrl, 'models');
  const resp = await upstreamRequest({
    url,
    method: 'GET',
    headers: { Accept: 'application/json', ...authHeaders(cfg) },
  });
  if (resp.status < 200 || resp.status >= 300) return fail(res, resp.status, await describeUpstreamError(resp));
  const raw = await collect(resp.stream, 4 * 1024 * 1024);
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { return fail(res, 502, '上游返回的不是 JSON: ' + raw.toString('utf8').slice(0, 300)); }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
  const models = list
    .map((m) => (typeof m === 'string' ? { id: m } : { id: m.id || m.name || m.model || '', owned_by: m.owned_by || m.ownedBy || '', display_name: m.display_name || '' }))
    .filter((m) => m.id);
  json(res, 200, { models, url });
}

/* ------------------------------------------------------------------ */
/* 路由：/api/test  （连通性自检）                                       */
/* ------------------------------------------------------------------ */

async function handleTest(req, res) {
  const body = await readJsonBody(req);
  const cfg = body.provider || {};
  const t0 = Date.now();
  const url = joinUrl(cfg.baseUrl, 'models');
  const resp = await upstreamRequest({
    url, method: 'GET', headers: { Accept: 'application/json', ...authHeaders(cfg) },
  });
  const ms = Date.now() - t0;
  const ok = resp.status >= 200 && resp.status < 300;
  if (!ok) {
    const msg = await describeUpstreamError(resp);
    return json(res, ok ? 200 : 200, { ok: false, ms, url, message: msg });
  }
  const raw = await collect(resp.stream, 4 * 1024 * 1024);
  let count = 0;
  try {
    const p = JSON.parse(raw.toString('utf8'));
    const l = Array.isArray(p) ? p : p.data || p.models || [];
    count = Array.isArray(l) ? l.length : 0;
  } catch { /* ignore */ }
  json(res, 200, { ok: true, ms, url, modelCount: count });
}

/* ------------------------------------------------------------------ */
/* 路由：/api/upload   （参考图临时文件通道）                            */
/* ------------------------------------------------------------------ */

async function handleUpload(req, res) {
  const buf = await readBody(req);
  if (!buf.length) return fail(res, 400, '空文件');
  const id = crypto.randomBytes(16).toString('hex');
  await fsp.writeFile(path.join(UPLOAD_DIR, id), buf);
  json(res, 200, { id, bytes: buf.length });
}

/* ------------------------------------------------------------------ */
/* 路由：/api/images/generations  （文生图 / 图生图 / 编辑）              */
/* ------------------------------------------------------------------ */

function normalizeImageOut(j) {
  const usage = j.usage || null;
  const items = [];
  for (const d of j.data || []) {
    if (d.b64_json) items.push({ type: 'b64', data: d.b64_json });
    else if (d.url) items.push({ type: 'url', url: d.url });
    else if (typeof d === 'string') items.push({ type: 'url', url: d });
  }
  return { items, revisedPrompt: (j.data && j.data[0] && j.data[0].revised_prompt) || j.revised_prompt || '', usage, created: j.created || Date.now() };
}

async function handleGeneration(req, res, mode) {
  const body = await readJsonBody(req);
  const cfg = body.provider || {};
  const p = body.params || {};

  // 组装图片输入
  const images = [];
  for (const img of body.images || []) {
    let buf;
    if (img.uploadId) {
      if (!UPLOAD_ID.test(img.uploadId)) throw Object.assign(new Error('非法上传 id'), { status: 400 });
      buf = await fsp.readFile(path.join(UPLOAD_DIR, img.uploadId));
    } else if (img.dataUrl) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(img.dataUrl);
      if (!m) throw Object.assign(new Error('参考图画不是合法 dataURL'), { status: 400 });
      buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    } else continue;
    images.push({ name: img.name || 'image.png', mime: img.mime || 'image/png', buf });
  }

  const hasImages = images.length > 0;
  let endpoint = mode === 'edit' ? 'images/edits' : 'images/generations';
  let url = joinUrl(cfg.baseUrl, endpoint);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return fail(res, 400, '提示词为空');

  // 常用可选参数（空值不发送）
  const opt = {};
  if (p.size && p.size !== 'auto') opt.size = p.size;
  if (p.quality) opt.quality = p.quality;
  if (p.background) opt.background = p.background;
  if (p.output_format) opt.output_format = p.output_format;
  if (p.n) opt.n = p.n;
  if (p.moderation && mode === 'generate') opt.moderation = p.moderation;

  let resp;
  let usedEndpoint = endpoint;

  // 优先 JSON + 图片 dataURL（兼容面最广：绝大多数中转对 images/edits 也是 JSON）
  // 失败后自动降级到标准 multipart/form-data
  async function tryJson(target) {
    const payload = { model: cfg.model, prompt, ...opt };
    if (hasImages) payload.images = images.map((im) => `data:${im.mime};base64,${im.buf.toString('base64')}`);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(cfg) };
    return upstreamRequest({ url: joinUrl(cfg.baseUrl, target), method: 'POST', headers, body: JSON.stringify(payload) });
  }

  async function tryMultipart(target, field) {
    const fd = new FormData();
    fd.append('model', cfg.model);
    fd.append('prompt', prompt);
    for (const [k, v] of Object.entries(opt)) fd.append(k, String(v));
    if (field === 'image[]') {
      for (const im of images) fd.append('image[]', new Blob([im.buf], { type: im.mime }), im.name);
    } else {
      images.forEach((im, i) => fd.append(i === 0 ? 'image' : 'image[]', new Blob([im.buf], { type: im.mime }), im.name));
    }
    const r = new Request('http://x/', { method: 'POST', body: fd });
    const headers = Object.fromEntries(r.headers.entries());
    delete headers['content-length'];
    const buf = Buffer.from(await r.arrayBuffer());
    return upstreamRequest({ url: joinUrl(cfg.baseUrl, target), method: 'POST', headers: { ...headers, ...authHeaders(cfg) }, body: buf });
  }

  const attempts = [];
  if (hasImages) {
    attempts.push(() => tryJson('images/edits'));
    attempts.push(() => tryMultipart('images/edits', 'image[]'));
    attempts.push(() => tryMultipart('images/edits', 'image'));
    attempts.push(() => tryJson('images/generations')); // 少数中转允许 generations 直接带图
  } else {
    attempts.push(() => tryJson('images/generations'));
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      resp = await attempt();
      usedEndpoint = errors.length ? 'fallback' : endpoint;
      if (resp.status >= 200 && resp.status < 300) break;
      errors.push(await describeUpstreamError(resp));
      resp = null;
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!resp) return fail(res, 502, '所有请求方式均失败：\n' + errors.join('\n'));

  const raw = await collect(resp.stream);
  let j;
  try {
    j = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail(res, 502, '上游返回非 JSON（前 400 字符）：\n' + raw.toString('utf8').slice(0, 400));
  }
  if (j.error) return fail(res, 502, j.error.message || JSON.stringify(j.error));
  const out = normalizeImageOut(j);
  if (!out.items.length) return fail(res, 502, '上游未返回图片：' + JSON.stringify(j).slice(0, 400));
  json(res, 200, { ...out, url: url, attempts: errors });
}

/* ------------------------------------------------------------------ */
/* 路由：/api/chat  （SSE 流式）                                        */
/* ------------------------------------------------------------------ */

async function handleChat(req, res) {
  const body = await readJsonBody(req);
  const cfg = body.provider || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return fail(res, 400, 'messages 为空');

  // 载入参考图：文本模型若支持 image_url 输入，则挂到第一条 user 消息
  const images = [];
  for (const img of body.images || []) {
    let buf;
    if (img.uploadId) {
      if (!UPLOAD_ID.test(img.uploadId)) throw Object.assign(new Error('非法上传 id'), { status: 400 });
      buf = await fsp.readFile(path.join(UPLOAD_DIR, img.uploadId));
    } else continue;
    images.push({ mime: img.mime || 'image/png', buf });
  }
  if (images.length) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const parts = [];
      if (lastUser.content) parts.push({ type: 'text', text: String(lastUser.content) });
      for (const im of images) parts.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.buf.toString('base64')}`, detail: 'auto' } });
      lastUser.content = parts;
    }
  }

  const payload = { model: cfg.model, messages, stream: true };
  const p = body.params || {};
  if (typeof p.temperature === 'number') payload.temperature = p.temperature;
  if (typeof p.max_tokens === 'number') payload.max_tokens = p.max_tokens;
  if (p.reasoning_effort) payload.reasoning_effort = p.reasoning_effort;
  if (typeof p.stream === 'boolean') payload.stream = p.stream;

  const url = joinUrl(cfg.baseUrl, 'chat/completions');
  const resp = await upstreamRequest({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(cfg) },
    body: JSON.stringify(payload),
  });

  if (resp.status < 200 || resp.status >= 300) return fail(res, resp.status, await describeUpstreamError(resp));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ctype = String(resp.headers['content-type'] || '');
  let closed = false;
  req.on('close', () => { closed = true; try { resp.stream.destroy(); } catch { /* ignore */ } });

  const t0 = Date.now();
  let usage = null;

  // 非 SSE（部分中转忽略 stream=true）：整包回来再吐一次
  if (!/text\/event-stream/i.test(ctype)) {
    const raw = await collect(resp.stream);
    const text = raw.toString('utf8');
    try {
      const j = JSON.parse(text);
      if (j.error) { send('error', { message: j.error.message || JSON.stringify(j.error) }); return res.end(); }
      const choice = j.choices && j.choices[0];
      const msg = choice && choice.message;
      const reasoning = (msg && (msg.reasoning_content || msg.reasoning)) || '';
      const content = (msg && (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))) || '';
      if (reasoning) send('reasoning', { delta: reasoning });
      if (content) send('delta', { delta: content });
      usage = j.usage || null;
      send('done', { ms: Date.now() - t0, usage });
    } catch {
      send('error', { message: '上游返回非 JSON：' + text.slice(0, 400) });
    }
    return res.end();
  }

  let buf = '';
  let sawDone = false;
  resp.stream.setEncoding('utf8');
  resp.stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { sawDone = true; continue; }
        if (!data) continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) { send('error', { message: j.error.message || JSON.stringify(j.error) }); continue; }
        if (j.usage) usage = j.usage;
        const ch = j.choices && j.choices[0];
        if (!ch) continue;
        const d = ch.delta || {};
        const reasoning = d.reasoning_content || d.reasoning || (d.reasoning_details && d.reasoning_details[0] && d.reasoning_details[0].text) || '';
        const content = typeof d.content === 'string' ? d.content : Array.isArray(d.content) ? d.content.map((c) => c.text || '').join('') : '';
        if (reasoning) send('reasoning', { delta: reasoning });
        if (content) send('delta', { delta: content });
        if (ch.finish_reason) send('finish', { reason: ch.finish_reason });
      }
    }
  });
  resp.stream.on('end', () => {
    if (!closed) {
      send('done', { ms: Date.now() - t0, usage, sawDone });
      res.end();
    }
  });
  resp.stream.on('error', (e) => {
    if (!closed) { send('error', { message: '上游流中断: ' + e.message }); res.end(); }
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  // 用「ROOT + 分隔符」做前缀判断：避免 public-evil/ 这类同前缀目录被误放行
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!file.startsWith(rootWithSep)) {
    return fail(res, 403, 'Forbidden');
  }
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('not file');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    fail(res, 404, 'Not found: ' + p);
  }
}

/* ------------------------------------------------------------------ */
/* 主服务                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const u = new URL(req.url, 'http://x');
  const route = u.pathname;
  try {
    if (req.method === 'OPTIONS') {
      // 注意：这里放开 CORS 是为了方便你把前端放到别的端口/域名上做二次开发。
      // 代价是：服务监听在 0.0.0.0 时，任何网页都能调用 /api/* 并消耗你的额度。
      // 默认只绑定 127.0.0.1，属于安全配置；对外暴露前请自行加鉴权。
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }
    if (route.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (route === '/api/health') return json(res, 200, { ok: true, version: '1.0.0', pid: process.pid });
      if (route === '/api/models' && req.method === 'POST') return await handleModels(req, res);
      if (route === '/api/test' && req.method === 'POST') return await handleTest(req, res);
      if (route === '/api/upload' && req.method === 'POST') return await handleUpload(req, res);
      if (route === '/api/images/generations' && req.method === 'POST') return await handleGeneration(req, res, 'generate');
      if (route === '/api/images/edits' && req.method === 'POST') return await handleGeneration(req, res, 'edit');
      if (route === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
      return fail(res, 404, '未知接口 ' + route);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '不支持的方法');
    return await serveStatic(req, res);
  } catch (e) {
    if (e && e.aborted) return;
    const code = e.status || 500;
    console.error(`[${new Date().toISOString()}] ${req.method} ${route} -> ${code}: ${e.message}`);
    if (route.startsWith('/api/')) fail(res, code, e.message);
    else { try { res.writeHead(500); res.end('error'); } catch { /* ignore */ } }
  } finally {
    if (process.env.LOG_ALL) console.log(`${req.method} ${route} ${Date.now() - started}ms`);
  }
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.timeout = DEFAULT_TIMEOUT;

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  \x1b[36m◆ Imagium\x1b[0m  服务已启动');
  console.log(`  \x1b[2m本地地址\x1b[0m   http://${HOST}:${PORT}`);
  console.log(`  \x1b[2m静态目录\x1b[0m   ${ROOT}`);
  console.log(`  \x1b[2m上传暂存\x1b[0m   ${UPLOAD_DIR}`);
  console.log('  \x1b[2m按 Ctrl+C 停止\x1b[0m');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可用 PORT=端口号 node server.js 换一个端口。`);
    process.exit(1);
  }
  throw e;
});
