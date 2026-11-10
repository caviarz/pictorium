/**
 * 动图专项测试：生成 → 存储 → 刷新恢复 → 下载 全链路不丢帧
 * 自起服务、自起浏览器，跑完全部关闭，不留常驻进程。
 * 使用真实 API（耗时约 1-2 分钟）
 *
 * 需要一个支持动图的 OpenAI 兼容供应商，通过环境变量提供：
 *   API_BASE_URL=https://your-provider.example/v1
 *   API_KEY=sk-...
 *   API_MODEL=gpt-image-1        # 可选，默认 gpt-image-1
 *
 * 未设置这些变量时脚本会直接跳过（退出码 0），避免 CI 里误报失败。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { findChromium } = require('./test-helpers');

const BASE_URL = process.env.API_BASE_URL || '';
const KEY = process.env.API_KEY || '';
const MODEL = process.env.API_MODEL || 'gpt-image-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpPort = 9800 + Math.floor(Math.random() * 60);

if (!BASE_URL || !KEY) {
  console.log('SKIP  未设置 API_BASE_URL / API_KEY，跳过真实 API 动图测试');
  process.exit(0);
}
// 只打印前缀，避免把密钥写进 CI 日志
console.log('使用供应商:', BASE_URL, '| 模型:', MODEL, '| key:', KEY.slice(0, 6) + '…');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** 自起服务，返回 { base, proc } */
async function startServer() {
  if (process.env.BASE) return { base: process.env.BASE, proc: null };
  const srvPort = 8900 + Math.floor(Math.random() * 80);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(srvPort) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${srvPort}`;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return { base, proc }; } catch {}
    await sleep(150);
  }
  throw new Error('本地服务启动失败');
}

(async () => {
  const { base, proc: srvProc } = await startServer();
  console.log('服务:', base);

  const chromeProc = spawn(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900',
    `--remote-debugging-port=${cdpPort}`,
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'aic-animtest-' + cdpPort),
    'about:blank'], { stdio: 'ignore' });

  const cleanup = async () => {
    try { await browser?.close(); } catch {}
    try { chromeProc.kill(); } catch {}
    try { srvProc?.kill(); } catch {}
  };

  let browser;
  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) break; } catch {}
      await sleep(150);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.evaluate(({ key, baseUrl, model }) => {
      localStorage.clear();
      indexedDB.deleteDatabase('ai-canvas');
      localStorage.setItem('aic.provider.v1', JSON.stringify({
        baseUrl, apiKey: key, authStyle: 'bearer',
        imageModel: model, chatModel: '', headersText: '',
      }));
    }, { key: KEY, baseUrl: BASE_URL, model: MODEL });
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(700);
    if (await page.locator('#drawer').isVisible()) { await page.click('#btnDrawerClose'); await sleep(200); }

    // T0 工具已加载
    check('T0 AnimUtil 已加载', await page.evaluate(() => typeof AnimUtil?.sniffB64 === 'function'));

    // T1 动图提示词 + 固定尺寸 → 自动改 auto
    await page.selectOption('#pSize', '1024x1024');
    await page.fill('#prompt', 'Create an animated GIF of a bouncing ball, looping');
    await sleep(200);
    const hint1 = await page.locator('#sizeHint').textContent();
    const sizeWillUse = await page.evaluate(() => __canvas.sizeForRequest());
    check('T1 动图提示词 + 固定尺寸 → 自动改用 auto',
      sizeWillUse === 'auto', `sizeForRequest=${sizeWillUse}, hint="${hint1}"`);

    // T2 普通提示词不干扰
    await page.fill('#prompt', 'a serene mountain lake at sunrise');
    await sleep(150);
    const sizeStill = await page.evaluate(() => __canvas.sizeForRequest());
    check('T2 普通提示词仍用用户选的尺寸', sizeStill === '1024x1024', `实际 ${sizeStill}`);

    // T3 真实生成动图
    console.log('  … 请求真实动图，预计 40-120 秒');
    await page.fill('#prompt', 'Create an animated GIF of a bouncing red ball on a white background, looping, multiple frames. The output must be an animated GIF.');
    await page.click('#btnSend');
    let got = false;
    for (let i = 0; i < 100; i++) {
      await sleep(2000);
      if (await page.locator('.card img').count() > 0) { got = true; break; }
      const st = await page.locator('#statusLine').textContent();
      if (/失败/.test(st)) { console.log('  生成失败:', st); break; }
    }
    check('T3 真实生成返回图片', got);
    if (got) {
      await sleep(2500);

      // T4 动图徽标
      const badge = await page.evaluate(() => {
        const card = document.querySelector('.card');
        const b = card?.querySelector('.anim-badge');
        return { hasBadge: !!b, text: b?.textContent?.trim() || '' };
      });
      check('T4 卡片显示动图徽标与帧数', badge.hasBadge && /动图/.test(badge.text), JSON.stringify(badge));

      // T5 IndexedDB 存的是真 GIF
      const stored = await page.evaluate(async () => {
        const keys = await ImageStore.keys();
        const blob = await ImageStore.get(keys[0]);
        const text = typeof blob === 'string' ? blob : null;
        if (!text) return { type: typeof blob };
        const b64 = text.split(',')[1] || '';
        const head = atob(b64.slice(0, 16));
        const raw = atob(b64.slice(0, Math.min(b64.length, 400000)));
        let frames = 0;
        for (let i = 0; i < raw.length - 1; i++) if (raw.charCodeAt(i) === 0x21 && raw.charCodeAt(i + 1) === 0xF9) frames++;
        return { isGif: head.startsWith('GIF'), frames, mime: text.slice(0, 22), sizeKB: Math.round(text.length / 1024) };
      });
      check('T5 IndexedDB 中保存的是 GIF 且多帧', stored.isGif && stored.frames > 1, JSON.stringify(stored));

      // T6 刷新后仍是动图（元数据含 animated/frames）
      await page.reload({ waitUntil: 'networkidle' });
      await sleep(2800);
      const afterReload = await page.evaluate(async () => {
        const card = document.querySelector('.card');
        const img = card?.querySelector('.card img');
        if (!img) return { missing: true };
        const blob = await (await fetch(img.src)).blob();
        const dec = new ImageDecoder({ data: blob.stream(), type: 'image/gif' });
        await dec.tracks.ready;
        const count = dec.tracks.selectedTrack.frameCount;
        const fps = [];
        for (let i = 0; i < count; i++) {
          const { image } = await dec.decode({ frameIndex: i });
          const c = document.createElement('canvas');
          c.width = image.displayWidth; c.height = image.displayHeight;
          c.getContext('2d').drawImage(image, 0, 0);
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let s = 0; for (let k = 0; k < d.length; k += 97) s = (s * 131 + d[k]) % 2147483647;
          fps.push(s); image.close();
        }
        dec.close();
        return {
          hasBadge: !!card.querySelector('.anim-badge'),
          cardAnimated: !!__canvas.cards[0]?.animated,
          frameCount: count,
          distinctFrames: new Set(fps).size,
          natural: img.naturalWidth + 'x' + img.naturalHeight,
        };
      });
      check('T6 刷新后徽标仍在 + 可逐帧解码',
        afterReload.hasBadge && afterReload.cardAnimated && afterReload.frameCount > 1 && afterReload.distinctFrames > 1,
        JSON.stringify(afterReload));

      // T7 下载文件名为 .gif
      const fname = await page.evaluate(() => {
        const c = __canvas.cards.find((x) => x.animated);
        return c ? { name: __canvas.filenameFor(c, new Blob([], { type: 'image/gif' })), frames: c.frames, format: c.format } : null;
      });
      check('T7 下载文件名使用 .gif', !!fname && /\.gif$/.test(fname.name), JSON.stringify(fname));

      // T8 暂停/恢复
      await page.click('.card .anim-badge');
      await sleep(500);
      const paused = await page.evaluate(() => {
        const card = document.querySelector('.card');
        return { paused: card.classList.contains('anim-paused'), text: card.querySelector('.anim-badge').textContent.trim() };
      });
      await page.click('.card .anim-badge');
      await sleep(400);
      const resumed = await page.evaluate(() => !document.querySelector('.card').classList.contains('anim-paused'));
      check('T8 点击徽标可暂停并恢复',
        paused.paused && /暂停/.test(paused.text) && resumed, JSON.stringify({ paused, resumed }));

      fs.mkdirSync('shots', { recursive: true });
      await page.screenshot({ path: path.resolve('shots', 'anim-test.png') });
    }

    // T9 无 JS 错误
    check('T9 无 JS 运行时错误', errors.length === 0, errors.join(' | '));

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  } catch (e) {
    console.log('FATAL', e.message);
  } finally {
    await cleanup();
  }
})();
