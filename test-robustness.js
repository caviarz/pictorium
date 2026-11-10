/**
 * 健壮性测试：损坏的本地数据不应导致白屏或崩溃
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { findChromium } = require('./test-helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpPort = 9750 + Math.floor(Math.random() * 40);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

(async () => {
  const port = await freePort();
  const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  let browser, ch;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await sleep(150); }
    const base = `http://127.0.0.1:${port}`;
    ch = spawn(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900',
      `--remote-debugging-port=${cdpPort}`, '--user-data-dir=' + path.join(require('os').tmpdir(), 'aic-rob-' + cdpPort), 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) break; } catch {} await sleep(150); }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const scenarios = [
      { name: 'R1 完全非法的 JSON', setup: () => { localStorage.setItem('aic.cards.v1', '{{{not json'); localStorage.setItem('aic.provider.v1', 'broken'); } },
      { name: 'R2 cards 不是数组', setup: () => { localStorage.setItem('aic.cards.v1', '{"a":1}'); } },
      { name: 'R3 数组项缺失 id', setup: () => { localStorage.setItem('aic.cards.v1', JSON.stringify([{ x: 1 }, null, {}])); } },
      { name: 'R4 引用了不存在的图片', setup: () => { localStorage.setItem('aic.cards.v1', JSON.stringify([{ id: 'ghost', x: 10, y: 10, w: 300, h: 200, prompt: 'gone', storageId: 'ghost' }])); } },
      { name: 'R5 字段类型全错', setup: () => { localStorage.setItem('aic.cards.v1', JSON.stringify([{ id: 'x1', x: 'abc', y: null, w: {}, h: [], src: 123 }])); } },
      { name: 'R6 provider 字段类型错乱', setup: () => { localStorage.setItem('aic.provider.v1', JSON.stringify({ baseUrl: 123, apiKey: null, authStyle: 5, imageModel: {} })); } },
      { name: 'R7 chat 历史类型错乱', setup: () => { localStorage.setItem('aic.chat.v1', JSON.stringify({ nope: true })); } },
      { name: 'R8 view 数据损坏', setup: () => { localStorage.setItem('aic.view.v1', 'garbage'); } },
      { name: 'R9 view 是数组', setup: () => { localStorage.setItem('aic.view.v1', '[1,2,3]'); } },
      { name: 'R10 view 数值非法', setup: () => { localStorage.setItem('aic.view.v1', JSON.stringify({ x: 'a', y: null, zoom: 0 })); } },
      { name: 'R11 provider 是数组', setup: () => { localStorage.setItem('aic.provider.v1', '[1,2]'); } },
      { name: 'R12 ui.mode 非法值', setup: () => { localStorage.setItem('aic.ui.v1', JSON.stringify({ mode: 123 })); } },
    ];

    for (const sc of scenarios) {
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.evaluate((fn) => {
        localStorage.clear();
        // 用字符串而非函数传参，避免序列化问题
        const code = fn;
        eval(code);
      }, `(${sc.setup.toString()})()`);
      errors.length = 0;
      await page.reload({ waitUntil: 'networkidle' });
      await sleep(1200);

      const state = await page.evaluate(() => ({
        bodyVisible: document.body.getBoundingClientRect().height > 0,
        hasPanel: !!document.getElementById('panel'),
        sendBtn: !!document.getElementById('btnSend'),
        cards: document.querySelectorAll('.card').length,
        emptyShown: (() => { const e = document.getElementById('emptyState'); return e ? getComputedStyle(e).display !== 'none' : null; })(),
      }));
      const ok = state.bodyVisible && state.hasPanel && state.sendBtn && errors.length === 0;
      check(sc.name, ok, `${JSON.stringify(state)}${errors.length ? ' errors=' + errors.join('|') : ''}`);
    }

    // 恢复：清空后一切正常
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(1000);
    const normal = await page.evaluate(() => ({
      cards: document.querySelectorAll('.card').length,
      emptyShown: getComputedStyle(document.getElementById('emptyState')).display !== 'none',
    }));
    check('R13 清空数据后恢复正常空状态', normal.cards === 0 && normal.emptyShown, JSON.stringify(normal));

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  } catch (e) { console.log('FATAL', e.message); }
  finally { try { await browser?.close(); } catch {} try { ch?.kill(); } catch {} try { srv.kill(); } catch {} }
})();
