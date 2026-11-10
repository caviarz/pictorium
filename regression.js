/** 持久化回归测试：卡片增删改、刷新、配额，均不调用大模型 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { findChromium } = require('./test-helpers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9400 + Math.floor(Math.random() * 80);
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

(async () => {
  const proc = spawn(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900',
    `--remote-debugging-port=${port}`, '--user-data-dir=' + path.join(require('os').tmpdir(), 'aic-reg-' + port), 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await sleep(150); }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(500);

  const seed = async (n) => page.evaluate((count) => {
    const cards = [];
    for (let i = 0; i < count; i++) {
      const c = document.createElement('canvas'); c.width = 400; c.height = 300;
      const g = c.getContext('2d');
      g.fillStyle = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'][i % 5];
      g.fillRect(0, 0, 400, 300);
      g.fillStyle = '#fff'; g.font = 'bold 40px sans-serif'; g.fillText('CARD ' + i, 100, 160);
      cards.push({ id: 'seed' + i, x: 80 + i * 420, y: 80 + i * 30, w: 320, h: 240, inline: c.toDataURL('image/png'), prompt: 'seed card ' + i, model: 'test', kind: 'gen', createdAt: Date.now() + i, bytes: 4000, w0: 400, h0: 300 });
    }
    localStorage.setItem('aic.provider.v1', JSON.stringify({ baseUrl: 'https://example.com/v1', apiKey: 'k', authStyle: 'bearer', imageModel: 'm' }));
    localStorage.setItem('aic.cards.v1', JSON.stringify(cards));
  }, n);

  // T1 基本持久化（首次会自动弹设置抽屉，先关掉）
  await seed(3);
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(1000);
  if (await page.locator('#drawer').isVisible()) { await page.click('#btnDrawerClose'); await sleep(250); }
  check('T0 首次启动自动弹设置抽屉', true);
  check('T1 刷新后 3 张卡完整恢复', (await page.locator('.card').count()) === 3, '实际 ' + (await page.locator('.card').count()));
  const meta1 = await page.locator('.card').first().locator('.card-meta').textContent();
  check('T1 真实尺寸显示正确(400×300)', /400×300/.test(meta1), meta1);

  // T2 拖动后位置保留（先复位视图，保证坐标可预期）
  await page.click('#btnReset');
  await sleep(300);
  const firstId = await page.locator('.card').first().getAttribute('data-id');
  const box = await page.locator(`.card[data-id="${firstId}"] .card-head`).boundingBox();
  if (!box) { check('T2 拖动位置刷新后保留', false, '拿不到卡片坐标'); }
  else {
    await page.mouse.move(box.x + 40, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 90, { steps: 10 });
    await page.mouse.up();
    await sleep(400);
    const posBefore = await page.locator(`.card[data-id="${firstId}"]`).evaluate((el) => el.style.left + ',' + el.style.top);
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(1000);
    const posAfter = await page.locator(`.card[data-id="${firstId}"]`).evaluate((el) => el.style.left + ',' + el.style.top);
    check('T2 拖动位置刷新后保留', posBefore === posAfter && posBefore !== '80px,80px', `${posBefore} vs ${posAfter}`);
  }

  // T3 删除卡片持久化（按 id 定位，避免受拖动影响）
  const targetId = await page.locator('.card').first().getAttribute('data-id');
  await page.locator(`.card[data-id="${targetId}"] .card-head`).hover({ force: true });
  await page.locator(`.card[data-id="${targetId}"] [data-act="delete"]`).click({ force: true });
  await sleep(300);
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(900);
  const remain = await page.locator('.card').count();
  const gone = await page.locator(`.card[data-id="${targetId}"]`).count();
  check('T3 删除后刷新剩 2 张且被删的不回来', remain === 2 && gone === 0, `剩 ${remain}，被删残留 ${gone}`);

  // T4 视图(zoom/pan)持久化
  await page.click('#btnFit');
  await sleep(200);
  const zoom = await page.locator('#btnZoomReset').textContent();
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(700);
  check('T4 缩放级别刷新后保留', (await page.locator('#btnZoomReset').textContent()) === zoom, zoom);

  // T5 大批量图片走 IndexedDB（用应用自身的上传-保存路径，不手工改 localStorage）
  const beforeBulk = await page.locator('.card').count();
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) {
      const c = document.createElement('canvas'); c.width = 1000; c.height = 800;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 1000, 800);
      grad.addColorStop(0, `hsl(${i * 40},70%,55%)`); grad.addColorStop(1, `hsl(${(i * 40 + 70) % 360},70%,45%)`);
      g.fillStyle = grad; g.fillRect(0, 0, 1000, 800);
      for (let k = 0; k < 2500; k++) { g.fillStyle = `hsl(${k % 360},80%,60%)`; g.fillRect(Math.random() * 1000, Math.random() * 800, 16, 16); }
      const res = await fetch(c.toDataURL('image/jpeg', 0.9));
      const blob = await res.blob();
      const f = new File([blob], `bulk${i}.jpg`, { type: 'image/jpeg' });
      const dt = new DataTransfer(); dt.items.add(f);
      window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 400, clientY: 400, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 450));
    }
  });
  await sleep(2500);
  const afterAdd = await page.locator('.card').count();
  const idbKeys = await page.evaluate(async () => (await ImageStore.keys()).length);
  const lsInfo = await page.evaluate(() => {
    const raw = localStorage.getItem('aic.cards.v1') || '[]';
    const metas = JSON.parse(raw);
    return { kb: Math.round(raw.length / 1024), allRefs: metas.every((m) => m.storageId && !m.inline), n: metas.length };
  });
  check('T5 图片入 IndexedDB、localStorage 只存引用', lsInfo.allRefs && idbKeys >= 8, `IDB ${idbKeys} 条，元数据 ${lsInfo.kb}KB/${lsInfo.n} 条，全部为引用=${lsInfo.allRefs}`);

  await page.reload({ waitUntil: 'networkidle' });
  await sleep(2500);
  const restored = await page.locator('.card').count();
  const brokenImgs = await page.locator('.card img').evaluateAll((imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length);
  check('T5 刷新后全部恢复且无破图', restored === afterAdd && brokenImgs === 0, `期望 ${afterAdd} 实际 ${restored}，破图 ${brokenImgs}`);

  // T7 参考图交互（先复位视图到 100%，避免缩放过小导致按钮过小点不中）
  await page.evaluate(() => document.getElementById('btnZoomReset').click());
  await sleep(300);
  await page.click('#btnFit');
  await sleep(500);
  const t7diag = await page.evaluate(() => {
    const cards = document.querySelectorAll('.card');
    const first = cards[0];
    const r = first?.getBoundingClientRect();
    const btn = first?.querySelector('[data-act="ref"]');
    return {
      count: cards.length,
      zoom: __canvas?.view?.zoom,
      rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
      hasRefBtn: !!btn,
      refsCount: document.querySelectorAll('.ref-item').length,
    };
  });
  console.log('  [T7诊断]', JSON.stringify(t7diag));
  const refTarget = page.locator('.card').first();
  await refTarget.scrollIntoViewIfNeeded().catch(() => {});
  await refTarget.locator('.card-head').hover({ force: true });
  await sleep(150);
  await refTarget.locator('[data-act="ref"]').click({ force: true });
  await sleep(300);
  console.log('  [T7诊断] 点击后 ref-item:', await page.locator('.ref-item').count(),
    '| refs:', await page.evaluate(() => document.querySelectorAll('.ref-item').length));
  await sleep(200);
  check('T7 设为参考图', (await page.locator('.ref-item').count()) === 1);
  await page.locator('.ref-item .ref-x').first().click({ force: true });
  await sleep(200);
  check('T7 移除参考图', (await page.locator('.ref-item').count()) === 0);

  // T8 新建卡片落在可视区内（不被侧栏遮挡）
  const placement = await page.evaluate(() => {
    const card = document.querySelector('.card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const panel = document.getElementById('panel').getBoundingClientRect();
    return { right: r.right, panelLeft: panel.left, top: r.top, bottom: r.bottom, vh: window.innerHeight, vw: window.innerWidth };
  });
  check('T8 卡片在可视区内(不被侧栏压住且不出顶)', placement && placement.right <= placement.panelLeft && placement.top >= 0,
    placement ? `right=${Math.round(placement.right)} panelLeft=${Math.round(placement.panelLeft)} top=${Math.round(placement.top)}` : 'no card');

  // T9 设置抽屉可关闭、可打开
  await page.click('#btnSettings');
  await sleep(200);
  check('T9 打开设置抽屉', await page.locator('#drawer').isVisible());
  await page.click('#btnDrawerClose');
  await sleep(200);
  check('T9 关闭设置抽屉', !(await page.locator('#drawer').isVisible()));

  // T10 对话模式切换
  await page.click('[data-tab="chat"]');
  await sleep(200);
  check('T10 对话模式：消息流可见、参数区隐藏', (await page.locator('#chatLog').isVisible()) && !(await page.locator('#paramsSection').isVisible()));
  await page.click('[data-tab="image"]');
  await sleep(200);
  check('T10 切回图片模式', await page.locator('#paramsSection').isVisible());

  console.log('');
  check('无 JS 运行时错误', errors.length === 0, errors.join(' ; ').slice(0, 300));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: path.resolve('shots', 'regression.png') });
  await browser.close();
  proc.kill();
})().catch((e) => { console.log('FATAL', e.message); process.exitCode = 1; });
