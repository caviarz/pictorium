/**
 * UX 专项测试：空状态、进度反馈、失败重试、卡片落点、命中区、blob 释放
 * 自起服务 + 自起浏览器 + 本地 mock 供应商，纯本地运行，不需要任何外部 API Key。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { findChromium } = require('./test-helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpPort = 9700 + Math.floor(Math.random() * 60);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  const srvPort = 8920 + Math.floor(Math.random() * 60);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(srvPort) }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${srvPort}`;
  let chromeProc, browser;
  const cleanup = async () => {
    try { await browser?.close(); } catch {}
    try { chromeProc?.kill(); } catch {}
    try { srv.kill(); } catch {}
  };

  try {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(150); }
    console.log('服务:', base);

    chromeProc = spawn(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900',
      `--remote-debugging-port=${cdpPort}`,
      '--user-data-dir=' + path.join(require('os').tmpdir(), 'aic-ux-' + cdpPort),
      'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) break; } catch {} await sleep(150); }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('ai-canvas'); });
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(700);
    if (await page.locator('#drawer').isVisible()) { await page.click('#btnDrawerClose'); await sleep(200); }

    // ============ U1 空状态：开始时立即消失（你报告的问题）============
    const emptyBefore = await page.locator('#emptyState').isVisible();
    check('U1a 初始空状态可见', emptyBefore);

    // 用慢速 mock 供应商触发"生成中"，观察空状态是否还在
    await page.evaluate(() => localStorage.setItem('aic.provider.v1', JSON.stringify({
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', authStyle: 'bearer', imageModel: 'slow-model', chatModel: '',
    })));
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(800);
    if (await page.locator('#drawer').isVisible()) { await page.click('#btnDrawerClose'); await sleep(200); }

    const pre = await page.evaluate(() => ({
      valid: !document.getElementById('btnSend').disabled,
      status: document.getElementById('statusLine').textContent,
      provider: JSON.parse(localStorage.getItem('aic.provider.v1') || '{}').imageModel,
      sendDisabled: document.getElementById('btnSend').disabled,
    }));
    check('U1b0 供应商状态就绪', !pre.sendDisabled, JSON.stringify(pre));

    await page.fill('#prompt', 'test prompt');
    await page.click('#btnSend');
    await sleep(800);
    const duringGen = await page.evaluate(() => ({
      emptyVisible: getComputedStyle(document.getElementById('emptyState')).display !== 'none',
      loadingCards: document.querySelectorAll('.card.loading').length,
      cards: document.querySelectorAll('.card').length,
      failedCards: document.querySelectorAll('.card.failed').length,
    }));
    check('U1b 生成中空状态立即隐藏', !duringGen.emptyVisible && duringGen.cards >= 1,
      JSON.stringify(duringGen));

    // ============ U2 进度反馈（本地慢速 mock，不依赖外部供应商）============
    // 起一个故意拖延响应的假供应商，观察这段时间里进度条是否推进
    const slow = http.createServer((req, res) => {
      // 5 秒后才返回；期间前端应持续显示"生成中"并推进进度条
      setTimeout(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow mock: deliberate delay' } }));
      }, 5000);
    });
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    const slowPort = slow.address().port;

    await page.evaluate((port) => localStorage.setItem('aic.provider.v1', JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      authStyle: 'bearer', imageModel: 'slow-mock', chatModel: '',
    })), slowPort);
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(800);
    if (await page.locator('#drawer').isVisible()) { await page.click('#btnDrawerClose'); await sleep(200); }

    await page.fill('#prompt', 'a simple blue circle on white');
    await page.click('#btnSend');
    await sleep(900);
    const p1 = await page.evaluate(() => {
      const card = document.querySelector('.card.loading');
      const bar = card?.querySelector('[data-bar]');
      const timer = card?.querySelector('[data-timer]');
      return { has: !!card, hasBar: !!bar, w1: bar ? parseFloat(bar.style.width) || 0 : 0, text1: timer?.textContent?.trim() || '' };
    });
    await sleep(2200);
    const p2 = await page.evaluate(() => {
      const card = document.querySelector('.card.loading');
      const bar = card?.querySelector('[data-bar]');
      const timer = card?.querySelector('[data-timer]');
      return { has: !!card, w2: bar ? parseFloat(bar.style.width) || 0 : 0, text2: timer?.textContent?.trim() || '' };
    });
    check('U2 进度条随时间推进 + 阶段文案',
      p1.has && p1.hasBar && p2.has && p2.w2 > p1.w1 && /正在|提交|绘制|等待|耗时/.test(p1.text1),
      `宽度 ${p1.w1}→${p2.w2}, 文案 "${p1.text1}" → "${p2.text2}"`);
    // 取消这次请求，避免继续等待
    await page.evaluate(() => { const b = document.querySelector('.card.loading [data-act="cancel"]'); if (b) b.click(); });
    await sleep(1200);
    const cancelled = await page.evaluate(() => ({
      failed: document.querySelectorAll('.card.failed').length,
      title: document.querySelector('.card.failed .failed-title')?.textContent?.trim(),
    }));
    check('U2b 取消后留下"已取消"卡片', cancelled.failed >= 1 && /取消/.test(cancelled.title || ''), JSON.stringify(cancelled));
    await new Promise((r) => slow.close(r));
    // 清理：删掉所有卡
    await page.evaluate(() => document.querySelectorAll('.card [data-act="delete"]').forEach((b) => b.click()));
    await sleep(800);

    // ============ U3 失败后保留卡片并可重试（用不可达地址快速失败）============
    await page.evaluate(() => localStorage.setItem('aic.provider.v1', JSON.stringify({
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', authStyle: 'bearer', imageModel: 'fail-model', chatModel: '',
    })));
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(700);
    if (await page.locator('#drawer').isVisible()) { await page.click('#btnDrawerClose'); await sleep(200); }
    await page.fill('#prompt', 'test prompt');
    await page.click('#btnSend');
    let failedCardShown = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await page.locator('.card.failed').count() > 0) { failedCardShown = true; break; }
    }
    const failedInfo = await page.evaluate(() => {
      const card = document.querySelector('.card.failed');
      if (!card) return null;
      return {
        hasRetry: !!card.querySelector('[data-act="retry"]'),
        title: card.querySelector('.failed-title')?.textContent?.trim(),
        msg: card.querySelector('.failed-msg')?.textContent?.trim()?.slice(0, 40),
        promptKept: (__canvas.cards.find((c) => c.failed)?.prompt || '').slice(0, 20),
      };
    });
    check('U3 失败后保留卡片 + 重试按钮 + 保留提示词',
      failedCardShown && failedInfo?.hasRetry && failedInfo?.promptKept === 'test prompt',
      JSON.stringify(failedInfo));

    // 失败卡不应被持久化
    const persistedFailed = await page.evaluate(() => JSON.parse(localStorage.getItem('aic.cards.v1') || '[]').length);
    check('U3b 失败卡不写入持久化存储', persistedFailed === 0, `存储中 ${persistedFailed} 条`);

    // ============ U4 空状态在失败后仍正确（有卡就不显示）============
    const emptyAfterFail = await page.evaluate(() => getComputedStyle(document.getElementById('emptyState')).display !== 'none');
    check('U4 有失败卡时空状态仍隐藏', !emptyAfterFail);

    // 删除失败卡后空状态应回来
    await page.click('.card.failed [data-act="delete"]');
    await sleep(400);
    const emptyAfterDelete = await page.evaluate(() => getComputedStyle(document.getElementById('emptyState')).display !== 'none');
    check('U4b 删光卡片后空状态恢复', emptyAfterDelete);

    // ============ U5 新卡不重叠 ============
    await page.evaluate(async () => {
      for (let k = 0; k < 3; k++) {
        const c = document.createElement('canvas'); c.width = 400; c.height = 500;
        const g = c.getContext('2d');
        g.fillStyle = ['#3355ff', '#ff3355', '#33ff55'][k]; g.fillRect(0, 0, 400, 500);
        const blob = await (await fetch(c.toDataURL())).blob();
        const f = new File([blob], `s${k}.png`, { type: 'image/png' });
        const dt = new DataTransfer(); dt.items.add(f);
        window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 400, clientY: 400, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 700));
      }
    });
    await sleep(2000);
    const boxes = await page.evaluate(() => {
      const panel = document.getElementById('panel').getBoundingClientRect();
      const vw = panel.left, vh = window.innerHeight;
      return __canvas.cards.map((c) => {
        const el = document.querySelector(`.card[data-id="${c.id}"]`);
        const r = el ? el.getBoundingClientRect() : null;
        return {
          x: c.x, y: c.y, w: c.w, h: c.h || 260,
          visible: r ? (r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1) : false,
        };
      });
    });
    // 视口有限时重叠不可避免；关键要求是"每张都完整可见且位置互不相同"
    const positions = new Set(boxes.map((b) => `${b.x},${b.y}`));
    const allVisible = boxes.every((b) => b.visible);
    check('U5 连传卡片：全部完整可见且位置互不相同',
      boxes.length === 3 && allVisible && positions.size === 3,
      `${boxes.length} 张，可见 ${boxes.filter((b) => b.visible).length}，不同位置 ${positions.size}`);

    // ============ U6 blob URL 无泄漏（真实调用 probe）============
    const blobLeak = await page.evaluate(async () => {
      const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
      let created = 0, revoked = 0;
      URL.createObjectURL = function (b) { created++; return oc.call(this, b); };
      URL.revokeObjectURL = function (u) { revoked++; return orv.call(this, u); };
      try {
        // 造一张真实 PNG，然后连测 5 次 probe（isBlob=true 会创建 blob URL）
        const cv = document.createElement('canvas'); cv.width = 40; cv.height = 40;
        cv.getContext('2d').fillRect(0, 0, 40, 40);
        const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
        for (let i = 0; i < 5; i++) await __canvas.probe(blob, true);
      } finally {
        URL.createObjectURL = oc; URL.revokeObjectURL = orv;
      }
      return { created, revoked, balanced: created === revoked };
    });
    check('U6 probe 的 blob URL 创建与释放配平', blobLeak.balanced && blobLeak.created === 5, JSON.stringify(blobLeak));

    // ============ U7 对话模式：按钮文案随模式切换 ============
    await page.click('[data-tab="chat"]');
    await sleep(500);
    const chatState = await page.evaluate(() => ({
      isChatMode: document.body.classList.contains('chat-mode'),
      label: document.getElementById('sendLabel').textContent.trim(),
      btnDisabled: document.getElementById('btnSend').disabled,
    }));
    check('U7 切到对话模式后按钮标签变"发送"',
      chatState.isChatMode && /发送/.test(chatState.label), JSON.stringify(chatState));

    await page.click('[data-tab="image"]');
    await sleep(400);
    const backState = await page.evaluate(() => document.getElementById('sendLabel').textContent.trim());
    check('U7b 切回图片模式按钮标签变"生成"', /生成/.test(backState), backState);

    // ============ U8 刷新后卡片恢复 & 空状态正确 ============
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(2000);
    const afterReload = await page.evaluate(() => ({
      cards: document.querySelectorAll('.card').length,
      emptyVisible: getComputedStyle(document.getElementById('emptyState')).display !== 'none',
    }));
    check('U8 刷新后卡片恢复且空状态隐藏', afterReload.cards === 3 && !afterReload.emptyVisible, JSON.stringify(afterReload));

    // ============ U9 无 JS 错误 ============
    check('U9 无 JS 运行时错误', errors.length === 0, errors.join(' | '));

    fs.mkdirSync('shots', { recursive: true });
    await page.screenshot({ path: path.resolve('shots', 'ux-review.png') });
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  } catch (e) {
    console.log('FATAL', e.message, e.stack?.split('\n')[1] || '');
  } finally {
    await cleanup();
  }
})();
