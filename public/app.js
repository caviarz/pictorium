/* ==========================================================================
   AI Canvas — 前端逻辑
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB');
const fmtTime = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');

/* ---------------------------------------------------------------- 存储 */
const LS = {
  provider: 'aic.provider.v1',
  cards: 'aic.cards.v1',
  chat: 'aic.chat.v1',
  ui: 'aic.ui.v1',
  view: 'aic.view.v1',
};

const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
  },
  set(k, v, quiet = false) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) {
      if (!quiet) toast('本地存储写入失败：' + (e.name === 'QuotaExceededError' ? '空间不足' : e.message), 'err');
      return false;
    }
  },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ---------------------------------------------------------------- 状态 */
const DEFAULT_PROVIDER = {
  name: '',
  baseUrl: '',
  apiKey: '',
  authStyle: 'bearer',
  imageModel: '',
  chatModel: '',
  headersText: '',
};

/** 从 localStorage 读数组；解析成功但不是数组时也要回退（旧版本/手改数据） */
const arr = (k) => {
  const v = store.get(k, []);
  return Array.isArray(v) ? v : [];
};

/** 读视图状态并做数值校验，避免损坏数据导致 NaN 缩放/平移 */
function readView() {
  const v = store.get(LS.view, null);
  const num = (n, dflt) => (typeof n === 'number' && Number.isFinite(n) ? n : dflt);
  if (!v || typeof v !== 'object') return { x: 90, y: 90, zoom: 1 };
  const zoom = num(v.zoom, 1);
  return {
    x: num(v.x, 90),
    y: num(v.y, 90),
    // 缩放限制在合理区间，防止 0 或极大值把画布弄没
    zoom: Math.min(4, Math.max(0.1, zoom)),
  };
}

/** 读供应商配置：逐字段校正类型，避免损坏数据让配置面板/请求构造崩溃 */
function readProvider() {
  const raw = store.get(LS.provider, null);
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const p = { ...DEFAULT_PROVIDER };
  for (const k of ['name', 'baseUrl', 'apiKey', 'headersText']) p[k] = str(src[k]);
  for (const k of ['imageModel', 'chatModel']) p[k] = str(src[k]);
  p.authStyle = ['bearer', 'x-api-key', 'both', 'none'].includes(src.authStyle) ? src.authStyle : 'bearer';
  return p;
}

const state = {
  provider: readProvider(),
  cards: [],
  chat: arr(LS.chat),
  refs: [],          // [{id, src, name, mime, bytes, w, h}]
  selected: new Set(),
  view: readView(),
  mode: (() => {
    const ui = store.get(LS.ui, {});
    return ui && typeof ui === 'object' && typeof ui.mode === 'string' ? ui.mode : 'image';
  })(),
  models: [],
  busy: {
    image: false,
    chat: false,
    signal: null,
    chatController: null,
  },
};

const cls = Object.create(null); // id -> 原始 class 字符串（用于重绘后恢复选中态）
let draft = {};                   // 设置抽屉里未保存的草稿
let drawerTouched = false;        // 用户是否已手动开/关过设置抽屉

/* ---------------------------------------------------------------- Toast */
function toast(msg, kind = '', ms = 3600) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ---------------------------------------------------------------- 视图 */
const viewport = $('viewport');
const world = $('world');

function applyView() {
  const { x, y, zoom } = state.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  $('btnZoomReset').textContent = Math.round(zoom * 100) + '%';
  world.querySelector('.grid-overlay').style.backgroundSize = `${24}px ${24}px`;
  store.set(LS.view, state.view);
}

function screenToWorld(sx, sy) {
  return { x: (sx - state.view.x) / state.view.zoom, y: (sy - state.view.y) / state.view.zoom };
}

function zoomAt(sx, sy, factor) {
  const z0 = state.view.zoom;
  const z1 = clamp(z0 * factor, 0.08, 6);
  if (z1 === z0) return;
  const w = screenToWorld(sx, sy);
  state.view.zoom = z1;
  state.view.x = sx - w.x * z1;
  state.view.y = sy - w.y * z1;
  applyView();
}

/* 平移：空格 / 中键 / 空白处拖拽 */
let pan = null;
viewport.addEventListener('pointerdown', (e) => {
  const onEmpty = e.target === viewport || e.target === world || e.target.classList.contains('grid-overlay') || e.target === $('nodeLayer');
  const wantPan = spaceDown || e.button === 1 || (e.button === 0 && onEmpty && !e.shiftKey);
  if (!wantPan) return;
  if (e.button === 0 && onEmpty && !spaceDown) { startMarquee(e); return; }
  e.preventDefault();
  pan = { sx: e.clientX, sy: e.clientY, ox: state.view.x, oy: state.view.y };
  viewport.classList.add('panning');
  viewport.setPointerCapture(e.pointerId);
});
viewport.addEventListener('pointermove', (e) => {
  if (!pan) return;
  state.view.x = pan.ox + (e.clientX - pan.sx);
  state.view.y = pan.oy + (e.clientY - pan.sy);
  applyView();
});
viewport.addEventListener('pointerup', () => {
  if (!pan) return;
  pan = null;
  viewport.classList.remove('panning');
});

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey || !e.shiftKey) {
    const factor = Math.exp(-e.deltaY * 0.0016);
    zoomAt(e.clientX, e.clientY, factor);
  } else {
    // Shift+滚轮 = 横向平移
    state.view.x -= e.deltaY;
    applyView();
  }
}, { passive: false });

/* 框选 */
let marquee = null;
function startMarquee(e) {
  const start = { x: e.clientX, y: e.clientY };
  const box = $('marquee');
  marquee = { start, box };
  box.hidden = false;
  if (!e.shiftKey) { state.selected.clear(); refreshSelection(); }
  const move = (ev) => {
    const x = Math.min(start.x, ev.clientX), y = Math.min(start.y, ev.clientY);
    const w = Math.abs(ev.clientX - start.x), h = Math.abs(ev.clientY - start.y);
    const tl = screenToWorld(x, y), br = screenToWorld(x + w, y + h);
    Object.assign(box.style, { left: tl.x + 'px', top: tl.y + 'px', width: (br.x - tl.x) + 'px', height: (br.y - tl.y) + 'px' });
    const r = { l: tl.x, t: tl.y, r: br.x, b: br.y };
    for (const c of state.cards) {
      const hit = c.x < r.r && c.x + c.w > r.l && c.y < r.b && c.y + cardTotalH(c) > r.t;
      if (hit) state.selected.add(c.id); else if (!ev.shiftKey) state.selected.delete(c.id);
    }
    refreshSelection();
  };
  const up = () => {
    box.hidden = true;
    marquee = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ---------------------------------------------------------------- 卡片渲染 */
const nodeLayer = $('nodeLayer');
const MAX_W = 4096;

/**
 * 计算「可视画布区」的中心落点（world 坐标）。
 * 可视区 = 窗口去掉右侧面板，再留出边距，保证新卡片完整可见。
 * 若算出的位置与已有卡片重叠，就按螺旋向外找空位，避免新图完全盖住旧图。
 */
function spawnPoint(cardW = 320, cardH = 320, index = 0, total = 1, reserved = null) {
  const availW = window.innerWidth - PANEL_W();
  const availH = window.innerHeight;
  const z = state.view.zoom;
  // 传入的 cardH 是图片区高度，实际卡片还要加上头部/信息条/提示词
  const extraH = CARD_CHROME_H;
  // 卡片比可视区还大就塞不下——等比收小到能完整显示（不影响真实图，只影响卡片显示尺寸）
  const maxDisplayW = Math.max(160, (availW - 48) / z * 0.9);
  const maxDisplayH = Math.max(160, ((availH - 48) / z - extraH) * 0.92);
  if (cardW > maxDisplayW || cardH > maxDisplayH) {
    const k = Math.min(maxDisplayW / cardW, maxDisplayH / cardH);
    cardW = Math.round(cardW * k);
    cardH = Math.round(cardH * k);
  }
  const cols = Math.min(total, 3);
  const col = index % cols;
  const row = Math.floor(index / cols);
  // 以可视区中心为锚
  const center = screenToWorld(availW / 2, availH / 2);
  // 让卡片完整落在可视区（含 24px 边距）；高度按整卡算
  const totalH = cardH + extraH;
  const halfW = (cardW * z) / 2;
  const halfH = (totalH * z) / 2;
  // 把中心点夹在「卡片能完整露出」的范围内
  const cx = clamp(center.x, (24 + halfW) / z, Math.max((24 + halfW) / z, (availW - 24 - halfW) / z));
  const cy = clamp(center.y, (24 + halfH) / z, Math.max((24 + halfH) / z, (availH - 24 - halfH) / z));
  // 多张时按网格错开，但不能再回到可视区外
  const offsetX = (col - (cols - 1) / 2) * (cardW * z + 16);
  const offsetY = row * (totalH * z + 16);

  const baseX = Math.round(cx + offsetX / z - cardW / 2);
  const baseY = Math.round(cy + offsetY / z - totalH / 2);
  // 一并返回实际显示尺寸（可能因视口太小而被收小）
  // 碰撞检测用「整卡高度」，否则底部会被低估约 100px
  const spot = findFreeSpot(baseX, baseY, cardW, cardH + extraH, reserved);
  return { ...spot, w: cardW, h: cardH };
}

/** 与已有卡片是否明显重叠（留 24px 呼吸空间视为不冲突）；reserved 用于同批多张互不重叠 */
function overlapsAny(x, y, w, h, pad = 24, reserved = null) {
  for (const c of state.cards) {
    if (!c || c.loading) continue; // 占位卡不算障碍
    const cw = c.w || 320;
    const ch = cardTotalH(c);
    if (x < c.x + cw + pad && x + w + pad > c.x && y < c.y + ch + pad && y + h + pad > c.y) return true;
  }
  if (reserved) {
    for (const r of reserved) {
      if (x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y) return true;
    }
  }
  return false;
}

/**
 * 螺旋搜索空位：优先向右下展开。
 * 关键约束：新卡片必须落在「当前可见的画布区」内，
 * 否则用户会看到图"没生成"，其实是被推到屏幕外了。
 */
function findFreeSpot(x, y, w, h, reserved = null) {
  const stepX = Math.round(w * 0.55);
  const stepY = Math.round(h * 0.55);
  // 搜索顺序：先右、再下、再左上……尽量把新图放在舒服的位置
  const ringOrder = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

  // 可视画布区（world 坐标），内缩 20px 留白
  const availW = window.innerWidth - PANEL_W();
  const z = state.view.zoom || 1;
  const tl = screenToWorld(20, 20);                              // 左上角
  const br = screenToWorld(availW - 20, window.innerHeight - 20); // 右下角
  const minX = Math.min(tl.x, br.x), maxX = Math.max(tl.x, br.x) - w;
  const minY = Math.min(tl.y, br.y), maxY = Math.max(tl.y, br.y) - h;
  // 卡片比可视区还大时，maxX/maxY 会小于 minX/minY，clamp 区间会反掉 —— 统一取上界为 min
  const hiX = Math.max(minX, maxX);
  const hiY = Math.max(minY, maxY);
  const clampSpot = (nx, ny) => ({
    x: Math.round(clamp(nx, minX, hiX)),
    y: Math.round(clamp(ny, minY, hiY)),
  });

  // 起点本身可能已被推出可视区，先拉回来再判断
  const start = clampSpot(x, y);
  x = start.x;
  y = start.y;

  if (!overlapsAny(x, y, w, h, 24, reserved)) return { x, y };
  /** 该位置是否「整体可见」 */
  const fullyVisible = (nx, ny) => nx >= minX - 1 && nx <= maxX + 1 && ny >= minY - 1 && ny <= maxY + 1;

  let fallback = null;
  for (let r = 1; r <= 12; r++) {
    for (const [dx, dy] of ringOrder) {
      const raw = { x: x + dx * stepX * r, y: y + dy * stepY * r };
      // 先判断原始候选点能否整体放进可视区，放不进就跳过（不能先裁剪再判断，
      // 否则所有越界候选都会被压回同一条边界，等于没有位移）
      if (raw.x < minX || raw.x > maxX || raw.y < minY || raw.y > maxY) continue;
      const spot = { x: Math.round(raw.x), y: Math.round(raw.y) };
      if (!fallback) fallback = spot;
      if (!overlapsAny(spot.x, spot.y, w, h, 12, reserved)) return spot;
    }
  }
  // 视口内找不到完全空位时，退到"最接近可用"的位置（仍保证可见）
  if (fallback) {
    // fallback 可能和已占位置重合，看起来像"只有一张图"。
    // 阶梯要保证「与本帧已有的所有卡片都不完全重合」，而不只是错开一个固定量。
    const taken = new Set(state.cards.filter((c) => !c.loading).map((c) => `${c.x},${c.y}`));
    const stepXN = Math.max(16, Math.round(stepX * 0.3));
    const stepYN = Math.max(16, Math.round(stepY * 0.3));
    for (let k = 1; k <= 12; k++) {
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const cand = clampSpot(fallback.x + sx * stepXN * k, fallback.y + sy * stepYN * k);
        const key = `${cand.x},${cand.y}`;
        // 既不能贴死边界（clamp 后未动），也不能和已有卡片同点
        if (key === `${fallback.x},${fallback.y}`) continue;
        if (taken.has(key)) continue;
        return cand;
      }
    }
    // 视口真的只有一丁点空间：按序号微移，绝不允许两张卡完全重合
    const idx = state.cards.filter((c) => !c.loading).length;
    return clampSpot(fallback.x + (idx % 6) * 8, fallback.y + (idx % 6) * 8);
  }
  // 视口内确实放不下（卡片太大/已铺满）：
  // 用「阶梯式错位」——每张都比上一张右下移一点，保证能看见、能拖开，
  // 而不是全部叠在同一个像素位置（那样看起来只有一张图）。
  const taken2 = new Set(state.cards.filter((c) => !c.loading).map((c) => `${c.x},${c.y}`));
  const dimg = Math.max(18, Math.round(28 * (z || 1)));
  for (let k = 1; k <= 12; k++) {
    const cand = clampSpot(
      x + Math.round(stepX * 0.25) + k * dimg,
      y + Math.round(stepY * 0.25) + k * dimg,
    );
    if (!taken2.has(`${cand.x},${cand.y}`)) return cand;
  }
  const idx2 = state.cards.filter((c) => !c.loading).length;
  return clampSpot(x + (idx2 % 6) * 8, y + (idx2 % 6) * 8);
}

function cardEl(c) {
  const el = document.createElement('div');
  el.className = 'card'
    + (state.selected.has(c.id) ? ' selected' : '')
    + (c.loading ? ' loading' : '')
    + (c.failed ? ' failed' : '');
  el.dataset.id = c.id;
  el.style.left = c.x + 'px';
  el.style.top = c.y + 'px';
  el.style.width = (c.w || 320) + 'px';

  const kindLabel = c.kind === 'upload' ? '参考' : c.kind === 'derived' ? '编辑' : '生成';
  const kindCls = c.kind === 'upload' ? 'upload' : c.kind === 'derived' ? 'derived' : '';
  const title = c.model || (c.kind === 'upload' ? '本地图片' : '');

  let media;
  if (c.loading) {
    media = `<div class="card-media"><div class="shimmer"></div>
      <div class="loading-text"><div class="spinner"></div>
        <div>${esc(c.label || '正在生成…')}</div>
        <div class="ld-bar"><i data-bar></i></div>
        <div class="loading-timer" data-timer></div></div></div>`;
  } else if (c.failed) {
    const cancelled = /取消/.test(c.error || '');
    media = `<div class="card-media failed-media">
      <div class="failed-inner">
        <div class="failed-icon">${cancelled ? '⏹' : '!'}</div>
        <div class="failed-title">${cancelled ? '已取消' : '生成失败'}</div>
        <div class="failed-msg" title="${esc(c.error || '')}">${esc(c.error || '未知错误')}</div>
        <div class="failed-actions">
          <button class="btn-mini primary" data-act="retry">重试</button>
          <button class="btn-mini" data-act="menu">更多</button>
        </div>
      </div></div>`;
  } else {
    const ratio = c.h && c.w ? c.h / c.w : 0;
    media = `<div class="card-media"><img src="${esc(c.src)}" alt="" draggable="false" />
      ${c.animated ? `<span class="anim-badge" title="动图 ${c.frames || ''} 帧 — 点击暂停/播放">
        <span class="anim-dot"></span>动图${c.frames ? ' · ' + c.frames + ' 帧' : ''}</span>` : ''}</div>`;
  }

  el.innerHTML = `
    <div class="card-head">
      <span class="card-kind ${kindCls}">${kindLabel}</span>
      <span class="card-title">${esc(title)}</span>
      <div class="card-actions">
        ${c.loading ? `<button class="ca" data-act="cancel" title="取消">✕</button>` : c.failed ? `
        <button class="ca" data-act="retry" title="重试">↻</button>
        <button class="ca del" data-act="delete" title="删除">✕</button>` : `
        <button class="ca" data-act="ref" title="设为参考图">＋</button>
        <button class="ca" data-act="edit" title="以此图为参考继续生成">✎</button>
        <button class="ca" data-act="menu" title="更多">⋯</button>
        <button class="ca del" data-act="delete" title="删除">✕</button>`}
      </div>
    </div>
    ${media}
    ${c.loading || c.failed ? '' : `<div class="card-meta"><span>${c.w0 || c.w || '?'}×${c.h0 || c.h || '?'}${c.animated ? ' · ' + (c.format || 'gif').toUpperCase() : ''}</span><span>${c.bytes ? fmtBytes(c.bytes) : ''}</span></div>`}
    ${c.prompt ? `<div class="card-prompt" title="${esc(c.prompt)}">${esc(c.prompt)}</div>` : ''}
    <div class="resize-h" data-h="resize"></div>
  `;
  if (c.animated) {
    const img = el.querySelector('.card-media img');
    const badge = el.querySelector('.anim-badge');
    let paused = false;
    let frozenSrc = null;
    const toggle = async (e) => {
      e.stopPropagation();
      e.preventDefault();
      paused = !paused;
      if (paused) {
        // 暂停：把当前可见帧画成静态图（浏览器对 drawImage(动图) 取第一帧）
        try {
          const cvs = document.createElement('canvas');
          const el2 = img;
          cvs.width = el2.naturalWidth || 1;
          cvs.height = el2.naturalHeight || 1;
          cvs.getContext('2d').drawImage(el2, 0, 0);
          frozenSrc = cvs.toDataURL('image/png');
          img.src = frozenSrc;
        } catch { /* 忽略，退化为隐藏 */ img.style.visibility = 'hidden'; }
        el.classList.add('anim-paused');
        badge.innerHTML = `<span class="anim-play">▶</span>已暂停`;
      } else {
        img.src = c.src;
        img.style.visibility = '';
        el.classList.remove('anim-paused');
        badge.innerHTML = `<span class="anim-dot"></span>动图${c.frames ? ' · ' + c.frames + ' 帧' : ''}`;
      }
    };
    badge.addEventListener('click', toggle);
    img.addEventListener('dblclick', toggle);
  }
  return el;
}

function renderCard(c) {
  const old = nodeLayer.querySelector(`.card[data-id="${c.id}"]`);
  const fresh = cardEl(c);
  if (old) old.replaceWith(fresh);
  else nodeLayer.appendChild(fresh);
  if (c.loading) startTimer(fresh, c);
  cls[c.id] = fresh.className;
}

/**
 * 占位卡计时器。只显示秒数会让用户不知道还要等多久，
 * 生成常要 30–120 秒，所以额外给出阶段说明和粗略进度条。
 */
function startTimer(el, c) {
  el.__t0 = el.__t0 || Date.now();
  const expected = (c.expectedMs || 45000); // 按实测中位数估
  const tick = () => {
    const t = el.querySelector('[data-timer]');
    if (!t || !el.isConnected || !c.loading) return;
    const sec = (Date.now() - el.__t0) / 1000;
    const ratio = Math.min(0.95, sec * 1000 / expected); // 最多到 95%，避免"已完成"的错觉
    let stage;
    if (sec < 3) stage = '正在连接…';
    else if (sec < 12) stage = '已提交，等待模型响应…';
    else if (sec < 40) stage = '模型正在绘制…';
    else if (sec < 90) stage = '仍在生成，图片较大时需要更久…';
    else stage = '耗时较长，可以点 ✕ 取消';
    t.innerHTML = `<span class="ld-stage">${stage}</span><span class="ld-sec">${sec.toFixed(0)}s</span>`;
    const bar = el.querySelector('[data-bar]');
    if (bar) bar.style.width = (ratio * 100).toFixed(1) + '%';
    requestAnimationFrame(() => setTimeout(tick, 250));
  };
  tick();
}

function refreshSelection() {
  for (const el of nodeLayer.children) {
    el.classList.toggle('selected', state.selected.has(el.dataset.id));
  }
}

/**
 * 持久化：元数据（位置/提示词/尺寸）走 localStorage，图片字节走 IndexedDB。
 * 顺序很重要：先确保图片字节已进 IndexedDB，再写引用它的元数据，
 * 否则会出现「元数据指向一个不存在的图片」→ 刷新后丢卡。
 */
let persistTimer = null;
let persistChain = Promise.resolve();

function persistCards(immediate = false) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    // 串行化，避免并发写导致顺序错乱
    persistChain = persistChain.then(() => flushCards()).catch(() => {});
  }, immediate ? 0 : 180);
}

async function flushCards() {
  const live = state.cards.filter((c) => !c.loading && !c.failed && c.src);

  // 1) 先把还没进 IndexedDB 的图片写进去
  for (const c of live) {
    if (c.blobUrl) continue;                        // 已是对象 URL，不用重复存
    if (!c.src.startsWith('data:')) continue;       // 远程 URL 不用存
    try {
      await ImageStore.put(c.id, c.src);
      c.storageId = c.id;
      c.inline = null;
    } catch {
      // IndexedDB 写入失败 → 回退为 localStorage 内联（受配额限制，但至少能恢复）
      c.storageId = null;
      c.inline = c.src;
    }
  }

  // 2) 再写元数据：只记录确实已持久化成功的位置
  const meta = live.map((c) => ({
    id: c.id, x: c.x, y: c.y, w: c.w, h: c.h,
    prompt: c.prompt, model: c.model, kind: c.kind,
    bytes: c.bytes, createdAt: c.createdAt, w0: c.w0, h0: c.h0,
    // 动图属性必须随元数据一起存，否则刷新后徽标与帧数就丢了
    animated: c.animated || undefined,
    frames: c.frames || undefined,
    format: c.format || undefined,
    mime: c.mime || undefined,
    meta: c.meta,
    storageId: c.storageId || undefined,
    inline: c.inline || undefined,
  }));

  if (!store.set(LS.cards, meta, true)) shedInline(meta);
}

function shedInline(meta) {
  for (const m of meta.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    if (!m.inline) continue;
    const live = state.cards.find((c) => c.id === m.id);
    if (live) { live.inline = null; live.srcBroken = true; }
    delete m.inline;
    if (store.set(LS.cards, meta, true)) { toast('存储紧张：部分旧图无法保存', 'err'); return true; }
  }
  toast('本地存储已满：建议及时下载图片', 'err', 6000);
  return false;
}

function addCard(c) {
  state.cards.push(c);
  renderCard(c);
  updateEmpty();
  persistCards();
  return c;
}

function removeCard(id) {
  const gone = state.cards.find((c) => c.id === id);
  if (gone) releaseCard(gone);
  state.cards = state.cards.filter((c) => c.id !== id);
  const el = nodeLayer.querySelector(`.card[data-id="${id}"]`);
  if (el) el.remove();
  state.selected.delete(id);
  ImageStore.del(id).catch(() => {});
  persistCards(true);
  updateEmpty();
}

/**
 * 空状态只在一张卡都没有时显示。
 * loading 占位卡也是卡——生成一开始就该把新手引导收起来，
 * 否则引导文案会一直浮在「正在生成…」的卡片上方，看起来像画布是空的。
 */
function updateEmpty() {
  const any = state.cards.length > 0;
  const el = $('emptyState');
  if (!el) return;
  el.style.display = any ? 'none' : '';
}

/* ---------------------------------------------------------------- 图片尺寸 */
function probe(path, isBlob) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = isBlob ? URL.createObjectURL(path) : null;
    const done = (v) => {
      // 必须释放，否则每次探测都残留一个 blob URL，长时间使用会持续吃内存
      if (url) URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done({ w: 0, h: 0 });
    img.src = url || path;
  });
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

/**
 * 超大静态图压到 MAX_W 以内。
 * 动图（GIF / 动画 WebP / APNG）永远原样保留 —— canvas 重绘只会得到第一帧，
 * 等于把动画毁掉，任何尺寸/体积理由都不能这么做。
 */
async function normalizeImage(blob, maxW = MAX_W) {
  // 用字节魔数判断，不依赖 blob.type（很多路径下它是空的）
  const kind = await AnimUtil.sniffBlob(blob);
  if (kind.animated) {
    const dataUrl = await blobToDataURL(blob);
    const probeInfo = await probe(blob, true);
    return {
      dataUrl,
      w: probeInfo.w, h: probeInfo.h,
      bytes: blob.size,
      mime: kind.mime,
      format: kind.format,
      animated: true,
      frames: kind.frames || 0,
      preservedOriginal: true,
    };
  }

  const probeInfo = await probe(blob, true);
  if (!probeInfo.w || probeInfo.w <= maxW) {
    const dataUrl = await blobToDataURL(blob);
    return {
      dataUrl,
      w: probeInfo.w, h: probeInfo.h,
      bytes: blob.size || Math.round(dataUrl.length * 0.75),
      mime: kind.mime || blob.type || 'image/png',
      format: kind.format,
      animated: false,
    };
  }

  const url = URL.createObjectURL(blob);
  const scale = maxW / probeInfo.w;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const cv = document.createElement('canvas');
  cv.width = Math.round(probeInfo.w * scale);
  cv.height = Math.round(probeInfo.h * scale);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(url);
  const dataUrl = cv.toDataURL('image/jpeg', 0.9);
  return {
    dataUrl,
    w: cv.width, h: cv.height,
    bytes: Math.round(dataUrl.length * 0.75),
    mime: 'image/jpeg',
    format: 'jpeg',
    animated: false,
  };
}

/* ---------------------------------------------------------------- 参考图 */
function renderRefs() {
  const strip = $('refStrip');
  strip.querySelectorAll('.ref-item').forEach((n) => n.remove());
  const drop = $('refDrop');
  for (const [i, r] of state.refs.entries()) {
    const el = document.createElement('div');
    el.className = 'ref-item';
    el.dataset.rid = r.id;
    el.title = `${r.name || '参考图'} · ${r.w}×${r.h}`;
    // src 可能来自上游返回的 URL，用属性转义避免引号破坏标签结构
    el.innerHTML = `<img src="${esc(r.src)}" alt="" draggable="false" />

      <span class="ref-idx">${i + 1}</span>
      <button class="ref-x" title="移除">✕</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('ref-x')) { removeRef(r.id); return; }
      openImageModal(r);
    });
    strip.insertBefore(el, drop);
  }
  $('refSection').style.display = state.mode === 'chat' ? '' : '';
  $('costHint').textContent = state.refs.length ? `${state.refs.length} 张参考图` : '';
  $('btnClearRefs').style.display = state.refs.length ? '' : 'none';
}

function addRef(ref) {
  const exists = state.refs.find((r) => r.src === ref.src);
  if (exists) { toast('这张图已经在参考图里了'); return; }
  if (state.refs.length >= 8) { toast('最多 8 张参考图', 'err'); return; }
  state.refs.push({ id: uid(), ...ref });
  renderRefs();
}

function removeRef(id) {
  state.refs = state.refs.filter((r) => r.id !== id);
  renderRefs();
}

async function addRefFromBlob(blob, name) {
  const n = await normalizeImage(blob);
  addRef({ src: n.dataUrl, w: n.w, h: n.h, bytes: n.bytes, mime: blob.type || 'image/png', name: name || 'reference' });
}

function addRefFromCard(c) {
  addRef({ src: c.src, w: c.w, h: c.h, bytes: c.bytes, mime: 'image/png', name: c.model || 'canvas' });
}

/* 参考图相关事件 */
$('btnAddRef').addEventListener('click', () => pickFiles('ref'));
$('refDrop').addEventListener('click', () => pickFiles('ref'));
$('btnClearRefs').addEventListener('click', () => { state.refs = []; renderRefs(); });

function pickFiles(target) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.addEventListener('change', async () => {
    for (const f of input.files || []) await handleFile(f, target);
  });
  input.click();
}

async function handleFile(f, target) {
  if (!f.type.startsWith('image/')) { toast('只支持图片文件：' + f.name, 'err'); return; }
  const total = state.refs.reduce((a, r) => a + (r.bytes || 0), 0);
  if (f.size > 40 * 1024 * 1024) { toast('单张图超过 40MB，请先压缩', 'err'); return; }
  if (total + f.size > 160 * 1024 * 1024) { toast('参考图总大小超限，请减少几张', 'err'); return; }
  try {
    if (target === 'canvas') {
      const n = await normalizeImage(f);
      const w = Math.round(clamp(n.w > 0 ? Math.min(n.w, 420) : 320, 180, 560));
      const h = n.w ? Math.round(w * n.h / n.w) : w;
      const at = spawnPoint(w, h, 0, 1);
      addCard({ id: uid(), kind: 'upload', x: at.x, y: at.y, w: at.w || w, h: at.h || h, w0: n.w, h0: n.h, src: n.dataUrl, prompt: f.name, createdAt: Date.now(), bytes: n.bytes });
      updateRefHintForUpload(f);
    } else {
      await addRefFromBlob(f, f.name);
    }
  } catch (e) {
    toast('读取图片失败：' + e.message, 'err');
  }
}

function updateRefHintForUpload() { /* 占位：上传后不自动加参考，保持可预期 */ }

/* 全局拖放 */
let dragDepth = 0;
['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    if (ev === 'dragenter') dragDepth++;
    $('composerBox').classList.add('hot');
    $('refDrop').classList.add('hot');
  })
);
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) { $('composerBox').classList.remove('hot'); $('refDrop').classList.remove('hot'); }
});
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  $('composerBox').classList.remove('hot');
  $('refDrop').classList.remove('hot');
  const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) { toast('没有可用的图片文件', 'err'); return; }
  // 落在输入区/参考区 = 参考图；落在画布 = 落图
  const onPanel = e.clientX > window.innerWidth - PANEL_W();
  for (const f of files) await handleFile(f, onPanel ? 'ref' : 'canvas');
  if (onPanel) toast(`已添加 ${files.length} 张参考图`, 'ok');
});

/* 粘贴 */
window.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []).filter((i) => i.type.startsWith('image/'));
  if (items.length) {
    e.preventDefault();
    for (const it of items) {
      const f = it.getAsFile();
      if (f) await handleFile(f, 'canvas');
    }
    toast('已粘贴到画布，并设为参考图', 'ok');
    const last = state.cards[state.cards.length - 1];
    if (last) { addRefFromCard(last); updateSendArea(); }
    return;
  }
  if (e.target === $('prompt')) {
    const text = e.clipboardData?.getData('text');
    if (text) { /* 默认可编辑 */ }
  }
});

/* ---------------------------------------------------------------- 卡片交互 */
const PANEL_W = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-w')) || 400;

nodeLayer.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;

  if (e.target.dataset.act) return; // 按钮自己处理
  if (marquee) return;

  const isResize = e.target.dataset.h === 'resize';
  if (!e.shiftKey && !state.selected.has(id)) { state.selected.clear(); state.selected.add(id); }
  else if (e.shiftKey) { state.selected.add(id); }
  refreshSelection();

  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const start = screenToWorld(e.clientX, e.clientY);
  const init = state.cards.filter((x) => state.selected.has(x.id)).map((x) => ({ c: x, x: x.x, y: x.y, w: x.w }));
  const baseW = c.w;
  const baseH = c.h;
  let moved = false;

  const move = (ev) => {
    const p = screenToWorld(ev.clientX, ev.clientY);
    const dx = p.x - start.x, dy = p.y - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2 / state.view.zoom) moved = true;
    if (isResize) {
      const nw = clamp(baseW + dx, 140, 2000);
      c.w = Math.round(nw);
      if (baseW && baseH) c.h = Math.round(baseH * (nw / baseW));
    } else {
      for (const it of init) { it.c.x = Math.round(it.x + dx); it.c.y = Math.round(it.y + dy); }
    }
    syncCardStyle(c);
    for (const it of init) if (it.c !== c) syncCardStyle(it.c);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) persistCards();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

function syncCardStyle(c) {
  const el = nodeLayer.querySelector(`.card[data-id="${c.id}"]`);
  if (!el) return;
  el.style.left = c.x + 'px';
  el.style.top = c.y + 'px';
  el.style.width = c.w + 'px';
}

/**
 * 卡片的「总高度」≈ 图片区高度 + 头部/信息条/提示词。
 * 之前一直用 c.h（仅图片区）做碰撞与可见性计算，
 * 导致卡片底部实际超出预估 100px 左右，落点约束全部偏低。
 */
const CARD_CHROME_H = 105; // head 39 + meta 30 + prompt 36
function cardTotalH(c) {
  const imgH = c?.h || 260;
  const hasPrompt = !!c?.prompt;
  return imgH + (hasPrompt ? CARD_CHROME_H : CARD_CHROME_H - 36);
}

nodeLayer.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.card');
  const c = state.cards.find((x) => x.id === card.dataset.id);
  if (!c) return;
  const act = btn.dataset.act;
  if (act === 'delete') { removeCard(c.id); return; }
  if (act === 'ref') { addRefFromCard(c); toast('已设为参考图', 'ok'); updateSendArea(); return; }
  if (act === 'edit') { addRefFromCard(c); focusPrompt(); toast('已放入参考图，写出想改的地方'); return; }
  if (act === 'cancel') { cancelGeneration(c.id); return; }
  if (act === 'retry') { retryFailedCard(c); return; }
  if (act === 'menu') { openContextMenu(e, c); return; }
});

/** 失败卡片重试：沿用它的提示词重新生成一次 */
async function retryFailedCard(c) {
  if (state.busy.image) { toast('上一张还在生成中'); return; }
  const prompt = c.prompt || $('prompt').value.trim();
  if (!prompt) { focusPrompt(); toast('这张卡没有记录提示词，请重新输入'); return; }
  $('prompt').value = prompt;
  autoGrow();
  updateSizeHint();
  // 在失败卡的位置重新起一张，失败卡本身先移除
  const { x, y } = c;
  removeCard(c.id);
  await generateImage({ spawnAt: { x, y }, promptOverride: prompt });
}

nodeLayer.addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const c = state.cards.find((x) => x.id === card.dataset.id);
  if (!c || c.loading) return;
  addRefFromCard(c);
  toast('已设为参考图', 'ok');
});

/* ---------------------------------------------------------------- 右键菜单 */
const ctxMenu = $('ctxMenu');
function openContextMenu(e, c) {
  e.preventDefault();
  e.stopPropagation();
  const items = [
    ['＋ 设为参考图', () => { addRefFromCard(c); toast('已设为参考图', 'ok'); }],
    ['✎ 以此图继续编辑', () => { addRefFromCard(c); focusPrompt(); }],
    ['⤓ 下载图片', () => downloadCard(c)],
    ['⧉ 复制图片到剪贴板', () => copyCard(c)],
    ['▣ 复制提示词', () => { navigator.clipboard.writeText(c.prompt || ''); toast('提示词已复制', 'ok'); }],
    ['sep'],
    ['⇧ 置于顶层', () => { bringToFront(c); }],
    ['⌫ 删除', () => removeCard(c.id), 'danger'],
  ];
  ctxMenu.innerHTML = '';
  for (const it of items) {
    if (it[0] === 'sep') { const s = document.createElement('div'); s.className = 'sep'; ctxMenu.appendChild(s); continue; }
    const b = document.createElement('button');
    b.textContent = it[0];
    if (it[2]) b.className = it[2];
    b.addEventListener('click', () => { hideContextMenu(); it[1](); });
    ctxMenu.appendChild(b);
  }
  ctxMenu.hidden = false;
  const x = Math.min(e.clientX, window.innerWidth - ctxMenu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - ctxMenu.offsetHeight - 8);
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
}
function hideContextMenu() { ctxMenu.hidden = true; }
window.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) hideContextMenu(); }, true);
window.addEventListener('blur', hideContextMenu);

function bringToFront(c) {
  nodeLayer.appendChild(nodeLayer.querySelector(`.card[data-id="${c.id}"]`));
  state.cards = state.cards.filter((x) => x !== c).concat([c]);
}

async function downloadCard(c) {
  let blob;
  try {
    const r = await fetch(c.src);
    blob = await r.blob();
    // 下载时确保 MIME 正确，某些路径 blob.type 会是空或错的
    if (!blob.type || blob.type === 'application/octet-stream') {
      const sniffed = await AnimUtil.sniffBlob(blob);
      if (sniffed.mime) blob = new Blob([blob], { type: sniffed.mime });
    }
  } catch {
    const a = document.createElement('a');
    a.href = c.src; a.download = filenameFor(c); a.click();
    return;
  }
  const name = filenameFor(c, blob);
  toFile(blob, name);
  if (/\.gif$/i.test(name)) toast('已下载动图 GIF', 'ok');
}

/** 文件名：扩展名以真实字节为准，不用 data: 前缀猜 */
function filenameFor(c, blob) {
  const stamp = new Date(c.createdAt || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let ext = '';
  if (blob) {
    const t = (blob.type || '').toLowerCase();
    if (t.includes('gif')) ext = 'gif';
    else if (t.includes('webp')) ext = 'webp';
    else if (t.includes('jpeg') || t.includes('jpg')) ext = 'jpg';
    else if (t.includes('png')) ext = 'png';
  }
  if (!ext && c.format) ext = AnimUtil.extFor(c.format);
  if (!ext) {
    const m = /^data:image\/([a-z0-9.+-]+)/i.exec(c.src || '');
    if (m) { const v = m[1].toLowerCase(); ext = v === 'jpeg' ? 'jpg' : v; }
  }
  return `ai-canvas-${stamp}.${ext || 'png'}`;
}

async function copyCard(c) {
  try {
    const blob = await (await fetch(c.src)).blob();
    const sniffed = await AnimUtil.sniffBlob(blob);
    // GIF 直接以原格式复制（剪贴板普遍支持 image/gif，重编码会只剩一帧）
    if (sniffed.format === 'gif') {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/gif': new Blob([blob], { type: 'image/gif' }) })]);
        toast('已复制动图到剪贴板', 'ok');
        return;
      } catch {
        // 某些环境不接受剪贴板中的 GIF，退化为 PNG 并明确告知
        const bmp = await createImageBitmap(blob);
        const cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        const png = await new Promise((r) => cv.toBlob(r, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        toast('剪贴板不支持 GIF，已复制动图的首帧（PNG）', 'err', 6000);
        return;
      }
    }
    const type = /png/.test(sniffed.mime || '') ? 'image/png' : /jpeg/.test(sniffed.mime || '') ? 'image/jpeg' : 'image/png';
    let out = blob;
    if (blob.type !== type) {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      out = await new Promise((r) => cv.toBlob(r, type));
    }
    await navigator.clipboard.write([new ClipboardItem({ [type]: out })]);
    toast('已复制到剪贴板', 'ok');
  } catch (e) {
    toast('复制失败（浏览器需要 HTTPS/localhost 才能写剪贴板）：' + e.message, 'err');
  }
}

/* ---------------------------------------------------------------- 大图预览 */
function openImageModal() { /* 简化：双击已用于设参考，预览用右键下载 */ }

/* ---------------------------------------------------------------- 键盘 */
let spaceDown = false;
window.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (e.code === 'Space' && !typing) { spaceDown = true; viewport.classList.add('pan-ready'); if (!e.repeat) e.preventDefault(); }

  if (typing) {
    if (e.key === 'Enter' && !e.shiftKey && e.target === $('prompt')) { e.preventDefault(); onSend(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); }
    if (e.key === 'Escape' && document.activeElement === $('prompt')) document.activeElement.blur();
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size) {
    e.preventDefault();
    for (const id of Array.from(state.selected)) removeCard(id);
  }
  if (e.key === 'Escape') {
    state.selected.clear(); refreshSelection();
    hideContextMenu();
    $('helpModal').hidden = true;
    if (!$('drawer').hidden) closeDrawer();
  }
  if (e.key === 'f' || e.key === 'F') fitAll();
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2); }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2); }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); resetView(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !state.selected.size) {
    e.preventDefault();
    state.cards.forEach((c) => state.selected.add(c.id));
    refreshSelection();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; viewport.classList.remove('pan-ready'); }
});

/* ---------------------------------------------------------------- 视图按钮 */
function fitAll() {
  const live = state.cards.filter((c) => !c.loading);
  const availW = window.innerWidth - PANEL_W();
  if (!live.length) { resetView(); return; }
  const minX = Math.min(...live.map((c) => c.x));
  const minY = Math.min(...live.map((c) => c.y));
  const maxX = Math.max(...live.map((c) => c.x + c.w));
  const maxY = Math.max(...live.map((c) => c.y + cardTotalH(c)));
  const pad = 60;
  const z = clamp(Math.min((availW - pad * 2) / (maxX - minX || 1), (window.innerHeight - pad * 2) / (maxY - minY || 1)), 0.08, 2);
  state.view.zoom = z;
  state.view.x = pad + (availW - pad * 2 - (maxX - minX) * z) / 2 - minX * z;
  state.view.y = pad + (window.innerHeight - pad * 2 - (maxY - minY) * z) / 2 - minY * z;
  applyView();
}
function resetView() { state.view = { x: 90, y: 90, zoom: 1 }; applyView(); }

$('btnZoomIn').addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2));
$('btnZoomOut').addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2));
$('btnZoomReset').addEventListener('click', resetView);
$('btnFit').addEventListener('click', fitAll);
$('btnReset').addEventListener('click', resetView);

/* ---------------------------------------------------------------- 供应商 */
function providerValid() {
  const p = state.provider;
  return !!p.baseUrl && (!!p.apiKey || p.authStyle === 'none');
}

function providerHost() {
  try { return new URL(/^https?:\/\//.test(state.provider.baseUrl) ? state.provider.baseUrl : 'https://' + state.provider.baseUrl).host; }
  catch { return state.provider.baseUrl || ''; }
}

function parsedHeaders() {
  const t = (state.provider.headersText || '').trim();
  if (!t) return {};
  try { const j = JSON.parse(t); return typeof j === 'object' && j ? j : {}; }
  catch { throw new Error('附加请求头不是合法 JSON'); }
}

function providerPayload(overrides = {}) {
  return { ...state.provider, ...overrides, headers: parsedHeaders() };
}

function syncProviderUI() {
  const p = state.provider;
  $('pbDot').className = 'pb-dot';
  if (!providerValid()) {
    $('pbName').textContent = '未配置供应商';
    $('pbModel').textContent = '点击右上角 ⚙ 进行设置';
  } else {
    $('pbName').textContent = providerHost();
    const img = p.imageModel || '（未选择模型）';
    const chat = p.chatModel && state.mode === 'chat' ? ` · 对话 ${p.chatModel}` : '';
    $('pbModel').textContent = img + chat;
  }
  $('cfgBaseUrl').value = p.baseUrl || '';
  $('cfgApiKey').value = p.apiKey || '';
  $('cfgAuthStyle').value = p.authStyle || 'bearer';
  $('cfgImageModel').value = p.imageModel || '';
  $('cfgChatModel').value = p.chatModel || '';
  $('cfgHeaders').value = p.headersText || '';
  renderModelPicker();
  updateSendArea();
}

function renderModelPicker() {
  const wrap = $('modelPicker');
  const dl = $('modelList');
  wrap.innerHTML = '';
  dl.innerHTML = '';
  const cur = (state.mode === 'chat' ? (draft.chatModel || $('cfgChatModel').value) : (draft.imageModel || $('cfgImageModel').value)) || '';
  for (const m of state.models) {
    const o = document.createElement('option');
    o.value = m.id;
    dl.appendChild(o);
    const b = document.createElement('button');
    b.className = 'mchip' + (m.id === cur ? ' on' : '');
    b.textContent = m.id;
    b.addEventListener('click', () => {
      // 只写草稿，用户点「保存」才落库
      if (state.mode === 'chat') { draft.chatModel = m.id; $('cfgChatModel').value = m.id; }
      else { draft.imageModel = m.id; $('cfgImageModel').value = m.id; }
      renderModelPicker();
    });
    wrap.appendChild(b);
  }
}

function saveProvider(announce = true) {
  const d = readDraft();
  state.provider.baseUrl = d.baseUrl || '';
  state.provider.apiKey = d.apiKey || '';
  state.provider.authStyle = d.authStyle || 'bearer';
  state.provider.imageModel = d.imageModel || '';
  state.provider.chatModel = d.chatModel || '';
  state.provider.headersText = d.headersText || '';
  store.set(LS.provider, state.provider);
  draft = { ...d };
  syncProviderUI();
  if (announce) { toast('已保存供应商设置', 'ok'); closeDrawer(); }
}

const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer', imageModel: 'gpt-image-1', chatModel: 'gpt-4o-mini' },
  compatible: { baseUrl: '', authStyle: 'bearer', imageModel: '' },
  local: { baseUrl: 'http://127.0.0.1:11434/v1', authStyle: 'none', imageModel: '' },
};

$('presetRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (!b) return;
  const p = PRESETS[b.dataset.preset];
  $('cfgBaseUrl').value = p.baseUrl;
  $('cfgAuthStyle').value = p.authStyle;
  if (p.imageModel) $('cfgImageModel').value = p.imageModel;
  if (p.chatModel) $('cfgChatModel').value = p.chatModel;
  // 预设同时写入草稿，避免"未保存 → 拉取/测试读不到"
  draft = { ...draft, ...p, headersText: $('cfgHeaders').value.trim() };
  toast('已填入预设，记得填 API Key 再保存');
});

$('btnToggleKey').addEventListener('click', () => {
  const inp = $('cfgApiKey');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  $('btnToggleKey').textContent = inp.type === 'password' ? '显示' : '隐藏';
});

// 输入即同步草稿，保证「未保存就拉取/测试」也能拿到当前值
['cfgBaseUrl', 'cfgApiKey', 'cfgAuthStyle', 'cfgImageModel', 'cfgChatModel', 'cfgHeaders'].forEach((id) => {
  const el = $(id);
  el.addEventListener('input', () => { try { readDraft(); } catch { /* JSON 未写完时忽略 */ } updateDrawerValid(); });
  el.addEventListener('change', () => { try { readDraft(); } catch { /* ignore */ } updateDrawerValid(); });
});

function updateDrawerValid() {
  const ok = !!$('cfgBaseUrl').value.trim();
  $('btnFetchModels').disabled = !ok;
  $('btnCfgTest').disabled = !ok;
}

$('btnFetchModels').addEventListener('click', () => fetchModels($('btnFetchModels')));
$('btnCfgTest').addEventListener('click', () => testProvider(true));
$('btnCfgSave').addEventListener('click', () => saveProvider());
$('btnSettings').addEventListener('click', openDrawer);
$('btnDrawerClose').addEventListener('click', closeDrawer);
$('drawerMask').addEventListener('click', closeDrawer);
$('pbTest').addEventListener('click', () => (providerValid() ? testProvider(false) : openDrawer()));
$('btnHelp').addEventListener('click', () => { $('helpModal').hidden = false; });
$('btnHelpClose').addEventListener('click', () => { $('helpModal').hidden = true; });

$('btnClearAll').addEventListener('click', () => {
  if (!confirm('确定清空本机保存的供应商、画布和对话？此操作不可撤销。')) return;
  Object.values(LS).forEach(store.del);
  location.reload();
});

function openDrawer() {
  drawerTouched = true;
  clearTimeout(window.__firstRunTimer);
  // 每次打开都以已保存配置为草稿基线
  draft = {
    baseUrl: state.provider.baseUrl || '',
    apiKey: state.provider.apiKey || '',
    authStyle: state.provider.authStyle || 'bearer',
    imageModel: state.provider.imageModel || '',
    chatModel: state.provider.chatModel || '',
    headersText: state.provider.headersText || '',
  };
  $('cfgBaseUrl').value = draft.baseUrl;
  $('cfgApiKey').value = draft.apiKey;
  $('cfgAuthStyle').value = draft.authStyle;
  $('cfgImageModel').value = draft.imageModel;
  $('cfgChatModel').value = draft.chatModel;
  $('cfgHeaders').value = draft.headersText;
  $('cfgResult').textContent = '';
  $('cfgResult').className = 'cfg-result';
  updateDrawerValid();
  $('drawer').hidden = false;
}

/** 读草稿：输入框有值就用输入框的，否则用草稿（兼容预设） */
function readDraft() {
  const v = (id, key) => {
    const val = $(id).value.trim();
    if (val) draft[key] = val;
    return draft[key] || '';
  };
  draft.baseUrl = v('cfgBaseUrl', 'baseUrl').replace(/\/+$/, '');
  draft.apiKey = $('cfgApiKey').value.trim() || draft.apiKey || '';
  draft.authStyle = $('cfgAuthStyle').value || draft.authStyle || 'bearer';
  draft.imageModel = $('cfgImageModel').value.trim() || draft.imageModel || '';
  draft.chatModel = $('cfgChatModel').value.trim() || draft.chatModel || '';
  draft.headersText = $('cfgHeaders').value.trim();
  return draft;
}

/** 发给服务端的供应商对象（含未保存的草稿） */
function draftProvider(overrides = {}) {
  const d = readDraft();
  let headers = {};
  try { headers = d.headersText ? JSON.parse(d.headersText) : {}; } catch { throw new Error('附加请求头不是合法 JSON'); }
  return { baseUrl: d.baseUrl, apiKey: d.apiKey, authStyle: d.authStyle, imageModel: d.imageModel, chatModel: d.chatModel, headers, ...overrides };
}

function closeDrawer() { drawerTouched = true; $('drawer').hidden = true; }

async function fetchModels(btn) {
  let provider;
  try { provider = draftProvider(); } catch (e) { $('cfgResult').className = 'cfg-result err'; $('cfgResult').textContent = '✗ ' + e.message; return; }
  if (!provider.baseUrl) { $('cfgResult').className = 'cfg-result err'; $('cfgResult').textContent = '先填 Base URL'; return; }
  const old = btn.textContent;
  btn.textContent = '拉取中…'; btn.disabled = true;
  const t0 = Date.now();
  try {
    const r = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'HTTP ' + r.status);
    state.models = j.models || [];
    $('cfgResult').className = 'cfg-result ok';
    $('cfgResult').textContent = `✓ 拉取到 ${state.models.length} 个模型（${Date.now() - t0}ms）`;
    renderModelPicker();
    if (!draft.imageModel) {
      const guess = state.models.find((m) => /image|dall|imagen|flux|sd/i.test(m.id));
      if (guess) { draft.imageModel = guess.id; $('cfgImageModel').value = guess.id; }
    }
  } catch (e) {
    $('cfgResult').className = 'cfg-result err';
    $('cfgResult').textContent = '✗ ' + e.message;
  } finally {
    btn.textContent = old; btn.disabled = false;
  }
}

function safeJSON(t) { try { return t ? JSON.parse(t) : {}; } catch { return {}; } }

async function testProvider(inDrawer) {
  let provider;
  try {
    provider = inDrawer ? draftProvider() : providerPayload();
  } catch (e) { toast(e.message, 'err'); return; }
  if (!provider.baseUrl) { openDrawer(); toast('先填 Base URL', 'err'); return; }
  const out = inDrawer ? $('cfgResult') : null;
  if (out) { out.className = 'cfg-result'; out.textContent = '测试中…'; }
  else $('pbDot').className = 'pb-dot';
  try {
    const r = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
    const j = await r.json();
    if (j.ok) {
      $('pbDot').className = 'pb-dot ok';
      if (out) { out.className = 'cfg-result ok'; out.textContent = `✓ 连接成功 ${j.ms}ms，${j.modelCount} 个模型`; }
      else toast(`连接成功 ${j.ms}ms`, 'ok');
    } else {
      $('pbDot').className = 'pb-dot err';
      if (out) { out.className = 'cfg-result err'; out.textContent = '✗ ' + j.message; }
      else toast('连接失败：' + j.message, 'err', 6000);
    }
  } catch (e) {
    $('pbDot').className = 'pb-dot err';
    const msg = '请求本地服务失败（server.js 是否在运行？）：' + e.message;
    if (out) { out.className = 'cfg-result err'; out.textContent = '✗ ' + msg; } else toast(msg, 'err', 6000);
  }
}

/* ---------------------------------------------------------------- 模式切换 */
function setMode(mode) {
  state.mode = mode;
  store.set(LS.ui, { ...store.get(LS.ui, {}), mode });
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
  $('modeTag').textContent = mode === 'chat' ? '对话' : '图片生成';
  $('paramsSection').hidden = mode !== 'image';
  $('chatParams').hidden = mode !== 'chat';
  $('chatLog').hidden = mode !== 'chat';
  $('refSection').hidden = mode !== 'image';
  document.body.classList.toggle('chat-mode', mode === 'chat');
  $('sendLabel').textContent = mode === 'chat' ? '发送' : '生成';
  $('btnRewrite').style.display = mode === 'chat' ? 'none' : '';
  $('prompt').placeholder = mode === 'chat'
    ? (state.provider.chatModel || state.provider.imageModel) ? '和模型聊聊…（Enter 发送 / Shift+Enter 换行）' : '先在设置里填对话模型，或直接用图片模型'
    : '描述你想生成的画面…（Enter 发送 / Shift+Enter 换行）';
  renderChat();
  syncProviderUI();
  updateSendArea();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.tab)));

/* ---------------------------------------------------------------- 发送区 */
function currentModel() {
  const p = state.provider;
  return state.mode === 'chat' ? (p.chatModel || p.imageModel) : p.imageModel;
}

function updateSendArea() {
  const ok = providerValid() && !!currentModel();
  $('btnSend').disabled = !ok && !(state.busy.image || state.busy.chat);
  $('statusLine').textContent = !providerValid()
    ? '未配置供应商 — 点 ⚙ 设置'
    : !currentModel()
      ? '未选择模型 — 点 ⚙ 选择'
      : (state.busy.image || state.busy.chat ? '生成中…' : '就绪');
  $('statusLine').className = !providerValid() || !currentModel() ? 'err' : '';
  $('costHint').textContent = state.refs.length
    ? `${state.refs.length} 张参考图 → ${state.mode === 'image' ? '图生图' : '多模态对话'}`
    : '';
}

/* ---------------------------------------------------------------- 尺寸与动图策略 */
/**
 * 动图请求判定：提示词里明确要动图时，即便用户选了固定尺寸也改发 auto。
 * 原因（实测）：固定尺寸会让模型走静态图路径，直接退回 PNG；
 * auto 才允许它按动图需要的画布尺寸出多帧 GIF。
 */
const ANIM_RE = /动图|动画|\bGIF\b|animated|animation|animat(e|ed|ing)|multi[- ]?frame|\bframes?\b|循环播放|looping|帧动画/i;

function wantsAnimation() {
  return ANIM_RE.test($('prompt').value || '');
}

function sizeForRequest() {
  const chosen = $('pSize').value;
  if (chosen === 'auto') return 'auto';
  if (wantsAnimation() && $('animAutoSize')?.checked) return 'auto';
  return chosen;
}

function updateSizeHint() {
  const hint = $('sizeHint');
  if (!hint) return;
  const anim = wantsAnimation();
  const chosen = $('pSize').value;
  if (anim && chosen !== 'auto' && $('animAutoSize')?.checked) {
    hint.textContent = '检测到动图需求 → 本次自动改用 auto 出多帧 GIF';
    hint.className = 'field-hint';
  } else if (anim && chosen !== 'auto') {
    hint.textContent = '固定尺寸下模型通常只返回静态 PNG';
    hint.className = 'field-hint warn';
  } else if (chosen === 'auto') {
    hint.textContent = '要生成动图请保持 auto';
    hint.className = 'field-hint';
  } else {
    hint.textContent = '';
    hint.className = 'field-hint';
  }
}

/* ---------------------------------------------------------------- 参考图 → 上传通道 */
async function toBlob(src) {
  const r = await fetch(src);
  let blob = await r.blob();
  if (!blob.type) {
    // 不能一律当 PNG：blob.type 为空时用魔数补齐，否则动图会被误标成 PNG
    const sniffed = await AnimUtil.sniffBlob(blob);
    blob = new Blob([blob], { type: sniffed.mime || 'image/png' });
  }
  return blob;
}

async function uploadRef(r) {
  const blob = await toBlob(r.src);
  const res = await fetch('/api/upload', { method: 'POST', body: blob });
  if (!res.ok) throw new Error('参考图上传失败 HTTP ' + res.status);
  const j = await res.json();
  return { uploadId: j.id, name: r.name || 'reference', mime: blob.type };
}

/* ---------------------------------------------------------------- 图片生成 */
const SIZE_BY_RATIO = (w, h) => {
  if (!w || !h) return null;
  const r = w / h;
  if (r > 1.15) return '1536x1024';
  if (r < 0.87) return '1024x1536';
  return '1024x1024';
};

async function onSend() {
  if (state.mode === 'chat') return sendChat();
  return generateImage();
}

/**
 * 忙碌状态。注意：图片生成与对话是两条独立通道，
 * 各自忙碌时只应禁用自己那一路，不能互相锁死。
 */
function setBusy(kind, on) {
  state.busy[kind] = on;
  const imageBusy = !!state.busy.image;
  const chatBusy = !!state.busy.chat;
  const inChat = state.mode === 'chat';
  const busyHere = inChat ? chatBusy : imageBusy;

  $('sendSpinner').hidden = !busyHere;
  $('sendLabel').textContent = busyHere ? '生成中…' : (inChat ? '发送' : '生成');
  // 只在「当前这条通道」忙碌时禁用；另一条仍可用
  $('btnSend').disabled = busyHere;
  $('btnStop').hidden = !(imageBusy || chatBusy);
  if (!busyHere) updateSendArea();
}

async function generateImage(opts = {}) {
  if (state.busy.image) { toast('上一张还在生成中'); return; }
  const prompt = (opts.promptOverride || $('prompt').value).trim();
  if (!prompt) { focusPrompt(); toast('先写点提示词'); return; }
  if (!providerValid()) { openDrawer(); toast('先配置供应商', 'err'); return; }
  if (!state.provider.imageModel) { openDrawer(); toast('先选择图片模型', 'err'); return; }

  const params = {
    size: sizeForRequest(),
    quality: $('pQuality').value,
    output_format: $('pFormat').value,
    n: Number($('pCount').value) || 1,
  };
  if (params.size === 'auto' && $('pKeepRatio').checked && state.refs.length) {
    const r = state.refs[0];
    const guess = SIZE_BY_RATIO(r.w, r.h);
    if (guess) params.size = guess;
  }
  if (params.output_format === 'keep') delete params.output_format;

  const controller = new AbortController();
  state.busy.signal = controller;

  // 占位卡：按目标尺寸估算高度
  const n = params.n || 1;
  const [tw, th] = (params.size && params.size !== 'auto' ? params.size.split('x').map(Number) : [1024, 1024]);
  const cardW = 320;
  const cardH = Math.round(cardW * (th / tw)) + 80;
  const placeholders = [];
  const batchSpots = [];
  for (let i = 0; i < n; i++) {
    // 重试时贴回原位置，避免新卡飞到别处
    const at = opts.spawnAt && i === 0
      ? { x: opts.spawnAt.x, y: opts.spawnAt.y, w: cardW, h: cardH }
      : spawnPoint(cardW, cardH, i, n, batchSpots);
    const useW = at.w || cardW;
    batchSpots.push({ x: at.x, y: at.y, w: useW, h: cardH });
    const c = {
      id: uid(), kind: state.refs.length ? 'derived' : 'gen', loading: true,
      x: at.x, y: at.y,
      w: useW, prompt, model: state.provider.imageModel,
    };
    placeholders.push(c);
    state.cards.push(c);
    renderCard(c);
  }
  updateEmpty();
  setBusy('image', true);
  $('statusLine').textContent = state.refs.length ? `图生图（参考图 ${state.refs.length} 张）…` : '文生图中…';
  $('statusLine').className = '';
  const t0 = Date.now();

  try {
    const images = [];
    for (const r of state.refs) images.push(await uploadRef(r));
    const endpoint = images.length ? '/api/images/edits' : '/api/images/generations';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerPayload(), params, prompt, images }),
      signal: controller.signal,
    });
    const j = await res.json().catch(() => ({ error: { message: '响应解析失败' } }));
    if (!res.ok || j.error) throw new Error(j.error?.message || 'HTTP ' + res.status);

    const items = j.items || [];
    const ms = Date.now() - t0;
    for (const ph of placeholders) removeCardOnly(ph.id);

    if (!items.length) throw new Error('上游没有返回图片');
    let animatedCount = 0;
    items.forEach((it, i) => {
      // 复用占位卡已经算好的位置（同批互不重叠），避免结果卡又叠在一起
      const at = i < batchSpots.length ? batchSpots[i] : spawnPoint(cardW, cardH, i, items.length, batchSpots);
      let src, format = 'unknown', animated = false, frames = 0;
      if (it.type === 'b64') {
        const sniffed = AnimUtil.sniffB64(it.data);
        format = sniffed.format;
        animated = sniffed.animated;
        frames = sniffed.frames || 0;
        src = `data:${sniffed.mime || 'image/png'};base64,${it.data}`;
      } else {
        src = it.url;
      }
      if (animated) animatedCount++;
      const card = {
        id: uid(), kind: images.length ? 'derived' : 'gen',
        x: at.x, y: at.y,
        w: at.w || cardW,
        createdAt: Date.now(), model: state.provider.imageModel,
        prompt: j.revisedPrompt || prompt, bytes: 0,
        src, format, animated, frames, mime: format,
        meta: { ms, usage: j.usage || null, attempts: j.attempts || [] },
      };
      addCard(card);
      hydrateCard(card);
    });
    $('statusLine').textContent = `✓ ${items.length} 张${animatedCount ? `（含 ${animatedCount} 张动图）` : ''} · ${fmtTime(ms)}`;
    $('statusLine').className = '';
    if (j.attempts && j.attempts.length) toast('已自动切换请求格式（' + j.attempts[0].slice(0, 80) + '…）');
    // 请求了动图但拿到静帧：明确告知原因与解法
    if (/gif|animat|动图|帧/i.test(prompt) && animatedCount === 0 && params.size && params.size !== 'auto') {
      toast('提示：模型返回了静帧。要生成动图请把「尺寸」设为 auto —— 固定尺寸（如 1024×1024）会让模型退回静态 PNG。', 'err', 9000);
    }
  } catch (e) {
    const aborted = e.name === 'AbortError';
    const msg = aborted ? '已取消' : friendlyError(e.message);
    // 保留一张「失败/取消」卡：让用户看得见刚才那次尝试，并能一键重试
    if (placeholders.length) {
      const ph = placeholders[0];
      for (const extra of placeholders.slice(1)) removeCardOnly(extra.id);
      ph.loading = false;
      ph.failed = true;
      ph.error = msg;
      ph.prompt = prompt;
      renderCard(ph);
    }
    $('statusLine').textContent = aborted ? '已取消' : '生成失败';
    $('statusLine').className = aborted ? '' : 'err';
    if (!aborted) toast(msg, 'err', 8000);
    updateEmpty();
  } finally {
    state.busy.signal = null;
    setBusy('image', false);
    updateEmpty();
  }
}

/** 用真实字节判断图片格式（含动图），不再靠固定截断猜 */
function guessMime(b64) {
  const info = AnimUtil.sniffB64(b64);
  return info.format === 'unknown' ? 'png' : info.format === 'jpeg' ? 'jpeg' : info.format;
}

/** 解码真实尺寸并保存 */
async function hydrateCard(card) {
  // 先把原始数据落盘一次，避免归一化途中刷新导致丢卡
  persistCards(true);
  let info = { w: 0, h: 0 };
  try { info = await probe(card.src); } catch { /* ignore */ }
  card.w0 = info.w;
  card.h0 = info.h;
  card.h = info.w ? Math.round(card.w * info.h / info.w) : 0;
  card.bytes = Math.round(Math.max(0, card.src.length - (card.src.indexOf(',') + 1)) * 0.75);
  renderCard(card);
  // 超宽图自动收窄到可读高度（只改显示尺寸，不动数据）
  if (card.h > 680) {
    card.w = Math.round(card.w * 680 / card.h);
    card.h = 680;
    syncCardStyle(card);
  }
  persistCards(true);
  try {
    const norm = await normalizeImage(await toBlob(card.src));
    if (norm.animated) {
      // 动图：保留原始字节，绝不重编码
      card.animated = true;
      card.frames = norm.frames || card.frames || 0;
      card.format = norm.format;
      card.mime = norm.mime;
      card.w0 = norm.w || card.w0;
      card.h0 = norm.h || card.h0;
      card.bytes = norm.bytes;
    } else {
      card.src = norm.dataUrl;
      card.w0 = norm.w;
      card.h0 = norm.h;
      card.bytes = norm.bytes;
      card.format = norm.format;
      card.mime = norm.mime;
      card.animated = false;
    }
    card.blobUrl = false;
    renderCard(card);
    persistCards(true);
  } catch { /* 保留原始 */ }
}

/** 释放卡片占用的 blob URL（读自 IndexedDB 的卡片才持有） */
function releaseCard(c) {
  if (c && c.blobUrl && c.src && c.src.startsWith('blob:')) {
    try { URL.revokeObjectURL(c.src); } catch { /* ignore */ }
    c.blobUrl = false;
  }
}

function removeCardOnly(id) {
  const gone = state.cards.find((c) => c.id === id);
  if (gone) releaseCard(gone);
  state.cards = state.cards.filter((c) => c.id !== id);
  state.selected.delete(id);
  const el = nodeLayer.querySelector(`.card[data-id="${id}"]`);
  if (el) el.remove();
}

function cancelGeneration(id) {
  if (state.busy.signal) state.busy.signal.abort();
}

function friendlyError(msg) {
  const m = String(msg || '');
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(m)) return '连接失败：检查 Base URL，或确认本地 server.js 正在运行';
  if (/401|invalid.*key|Unauthorized/i.test(m)) return '鉴权失败：API Key 不正确或无权限\n' + m;
  if (/404/.test(m)) return '接口或模型不存在：检查 Base URL 是否带 /v1、模型名是否正确\n' + m;
  if (/model/i.test(m) && /support|not found|不存在/i.test(m)) return '该供应商不支持这个模型：' + m;
  if (/timeout|超时/i.test(m)) return '请求超时：模型可能很慢，或供应商限制并发\n' + m;
  return m;
}

/* ---------------------------------------------------------------- 对话 */
function renderChat() {
  const log = $('chatLog');
  log.querySelectorAll('.msg').forEach((n) => n.remove());
  $('chatEmpty').style.display = state.chat.length ? 'none' : '';
  state.chat.forEach((m, i) => log.appendChild(buildMsg(m, i)));
  log.scrollTop = log.scrollHeight;
}

function buildMsg(m, idx) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  el.dataset.idx = idx;
  const wrap = document.createElement('div');
  wrap.className = 'msg-body';
  if (m.reasoning) {
    const th = document.createElement('div');
    th.className = 'msg-think';
    th.textContent = m.reasoning;
    wrap.appendChild(th);
  }
  const text = document.createElement('span');
  text.className = 'msg-text';
  text.textContent = m.content || '';
  wrap.appendChild(text);
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = m.role === 'user' ? '你' : (m.model || '助手');
  el.append(role, wrap);
  if (m.role === 'assistant' && m.content) {
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const b1 = document.createElement('button');
    b1.textContent = '填进提示词';
    b1.onclick = () => { $('prompt').value = m.content; focusPrompt(); };
    const b2 = document.createElement('button');
    b2.textContent = '复制';
    b2.onclick = () => { navigator.clipboard.writeText(m.content); toast('已复制', 'ok'); };
    const b3 = document.createElement('button');
    b3.textContent = '画出来';
    b3.onclick = () => { addRefFromCard; $('prompt').value = '把这段描述画成一张图：' + m.content; setMode('image'); focusPrompt(); };
    tools.append(b1, b2, b3);
    el.appendChild(tools);
  }
  return el;
}

async function sendChat() {
  const prompt = $('prompt').value.trim();
  if (!prompt) { focusPrompt(); return; }
  if (!state.busy.chat && state.refs.length && !state.provider.chatModel) {
    // 没有对话模型时提示，但仍允许用图片模型尝试
    if (!/vision|gpt-4|gpt-5|claude|qwen|gemini/i.test(state.provider.imageModel || '')) {
      toast('参考图需要支持视觉输入的对话模型，请在设置里填「对话模型」', 'err', 6000);
      return;
    }
  }
  state.chat.push({ role: 'user', content: prompt });
  const answer = { role: 'assistant', content: '', reasoning: '', model: currentModel() };
  state.chat.push(answer);
  $('prompt').value = '';
  autoGrow();
  renderChat();

  const controller = new AbortController();
  state.busy.chatController = controller;
  setBusy('chat', true);
  $('statusLine').textContent = '思考中…';
  $('statusLine').className = '';
  const t0 = Date.now();

  const node = $('chatLog').lastElementChild;
  const body = node.querySelector('.msg-text');
  node.querySelector('.msg-body').classList.add('cursor-blink');

  try {
    const images = [];
    for (const r of state.refs) images.push(await uploadRef(r));
    const messages = state.chat.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerPayload({ model: currentModel() }),
        messages,
        images,
        params: { temperature: Number($('cTemp').value), max_tokens: $('cMaxTokens').value ? Number($('cMaxTokens').value) : undefined },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: { message: 'HTTP ' + res.status } }));
      throw new Error(j.error?.message || 'HTTP ' + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (/event:\s*(\w+)/.exec(block) || [])[1];
        const dataLine = (/data:\s*(.*)/s.exec(block) || [])[1];
        if (!dataLine) continue;
        let d;
        try { d = JSON.parse(dataLine); } catch { continue; }
        if (ev === 'delta') { answer.content += d.delta; body.textContent = answer.content; scrollChat(); }
        else if (ev === 'reasoning') {
          answer.reasoning += d.delta;
          if (!body.parentElement.querySelector('.msg-think')) {
            const th = document.createElement('div');
            th.className = 'msg-think';
            body.parentElement.insertBefore(th, body);
          }
          body.parentElement.querySelector('.msg-think').textContent = answer.reasoning;
          scrollChat();
        } else if (ev === 'error') { throw new Error(d.message); }
        else if (ev === 'done') { answer.usage = d.usage; }
      }
    }
    node.querySelector('.msg-body').classList.remove('cursor-blink');
    $('statusLine').textContent = `✓ ${fmtTime(Date.now() - t0)}`;
    $('statusLine').className = '';
  } catch (e) {
    node.querySelector('.msg-body').classList.remove('cursor-blink');
    if (e.name === 'AbortError') {
      $('statusLine').textContent = '已停止';
      if (!answer.content) state.chat.pop();
    } else {
      $('statusLine').textContent = '对话失败';
      $('statusLine').className = 'err';
      answer.content = answer.content || '';
      const err = document.createElement('div');
      err.className = 'msg-err';
      err.textContent = friendlyError(e.message);
      node.querySelector('.msg-body').appendChild(err);
      toast(friendlyError(e.message), 'err', 7000);
    }
  } finally {
    state.busy.chatController = null;
    setBusy('chat', false);
    try { store.set(LS.chat, state.chat.slice(-60).map((m) => ({ role: m.role, content: m.content, reasoning: m.reasoning || '', model: m.model }))); } catch { /* ignore */ }
    renderChat();
  }
}

function scrollChat() {
  const log = $('chatLog');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

$('btnStop').addEventListener('click', () => {
  if (state.busy.signal) state.busy.signal.abort();
  if (state.busy.chatController) state.busy.chatController.abort();
});

/* ---------------------------------------------------------------- 输入区 */
const promptEl = $('prompt');
function autoGrow() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 220) + 'px';
}
promptEl.addEventListener('input', () => { autoGrow(); updateSizeHint(); });
$('pSize').addEventListener('change', updateSizeHint);
$('animAutoSize').addEventListener('change', updateSizeHint);
function focusPrompt() { promptEl.focus(); }

$('btnSend').addEventListener('click', onSend);
$('cTemp').addEventListener('input', () => { $('tempVal').textContent = $('cTemp').value; });

$('btnRewrite').addEventListener('click', () => {
  const cur = $('prompt').value.trim();
  if (!cur) { toast('先写一句粗略的描述，我来扩写'); return; }
  const targetModel = state.provider.chatModel || state.provider.imageModel;
  if (!providerValid() || !targetModel) { openDrawer(); toast('先配置供应商与模型', 'err'); return; }
  setMode('chat');
  $('prompt').value = `你是图片提示词工程师。把下面这条粗略描述扩写成一段高质量的图像生成提示词（中文回答，最后单独给出一段可直接使用的英文提示词）：\n\n${cur}`;
  autoGrow();
  focusPrompt();
  toast('已切到对话模式，按 Enter 让模型扩写');
});

/* ---------------------------------------------------------------- 启动 */
async function restoreCards() {
  const saved = store.get(LS.cards, []);
  if (!Array.isArray(saved) || !saved.length) return [];
  const out = [];
  for (const m of saved) {
    if (!m || !m.id) continue;
    let src = m.inline || m.src || '';
    let blobUrl = false;
    if (!src) {
      try {
        const blob = await ImageStore.get(m.storageId || m.id);
        if (blob) {
          src = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
          blobUrl = typeof blob !== 'string';
        }
      } catch { /* ignore */ }
    }
    if (!src) continue; // 图片确实丢了，就不要渲染一张空卡
    const restored = { ...m, src, blobUrl, storageId: m.storageId || (blobUrl || src.startsWith('data:') ? m.id : undefined) };
    // 旧数据或元数据缺失时，按真实字节补齐动图标记
    if (!restored.animated && src.startsWith('data:')) {
      const info = AnimUtil.sniffDataUrl(src);
      if (info.animated) {
        restored.animated = true;
        restored.frames = restored.frames || info.frames || 0;
        restored.format = restored.format || info.format;
        restored.mime = restored.mime || info.mime;
      }
    }
    out.push(restored);
  }
  return out;
}

async function boot() {
  try {
    state.cards = await restoreCards();
  } catch { state.cards = []; }

  for (const c of state.cards) {
    if (!c.h && c.w) c.h = Math.round(c.w * 0.75);
  }

  // 分批渲染：几百张图一次性同步渲染会卡住首屏
  const BATCH = 25;
  for (let i = 0; i < state.cards.length; i += BATCH) {
    for (const c of state.cards.slice(i, i + BATCH)) {
      renderCard(c);
      if (!c.w0) {
        // 恢复后补真实尺寸（异步，不阻塞首屏）
        probe(c.src).then((info) => {
          if (!info.w) return;
          c.w0 = info.w; c.h0 = info.h;
          renderCard(c);
        });
      }
    }
    // 让出主线程，界面不会被一次性渲染卡死
    if (i + BATCH < state.cards.length) await new Promise((r) => setTimeout(r, 0));
  }

  applyView();
  syncProviderUI();
  setMode(state.mode);
  updateEmpty();
  renderRefs();
  autoGrow();
  document.body.classList.remove('boot');

  // 首次使用引导：稍后自动打开设置；若用户已手动开/关过，就不要再抢
  if (!providerValid()) {
    const t = setTimeout(() => {
      if (!providerValid() && $('drawer').hidden && !drawerTouched) openDrawer();
    }, 500);
    window.__firstRunTimer = t;
  } else $('pbDot').className = 'pb-dot ok';
  drawerTouched = false;

  // 卸载/隐藏时立即落盘（仅当本页有卡，避免空状态覆盖）
  const flush = () => { if (state.cards.some((c) => !c.loading && c.src)) flushCards(); };
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  // 其他标签页改动时补充同步
  window.addEventListener('storage', (e) => {
    if (e.key !== LS.cards || !e.newValue) return;
    try {
      const incoming = JSON.parse(e.newValue);
      if (!Array.isArray(incoming)) return;
      const have = new Set(state.cards.map((c) => c.id));
      let added = 0;
      for (const m of incoming) {
        if (!have.has(m.id)) {
          ImageStore.get(m.storageId || m.id).then((blob) => {
            const src = m.inline || (blob ? (typeof blob === 'string' ? blob : URL.createObjectURL(blob)) : '');
            if (!src) return;
            state.cards.push({ ...m, src, storageId: m.storageId || m.id });
            renderCard(state.cards[state.cards.length - 1]);
            updateEmpty();
          }).catch(() => {});
          added++;
        }
      }
      if (added) toast(`另一个标签页更新了 ${added} 张图`, 'ok');
    } catch { /* ignore */ }
  });
}

boot();

/* 让 localStorage 存的卡片在重绘后也携带尺寸信息 */
window.addEventListener('resize', () => applyView());

// 双击画布空白处：适应全部
viewport.addEventListener('dblclick', (e) => {
  if (e.target.closest('.card')) return;
  fitAll();
});

// 暴露少量内部状态，便于自测与排查（只读为主）
window.__canvas = {
  get cards() { return state.cards; },
  get view() { return state.view; },
  get mode() { return state.mode; },
  sizeForRequest,
  wantsAnimation,
  filenameFor,
  normalizeImage,
  spawnPoint,
  probe,
  overlapsAny,
  AnimUtil: window.AnimUtil,
};

})();
