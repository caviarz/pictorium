/**
 * 跑 regression.js 的包装：自起 server.js、跑完杀掉，不在本机残留服务进程。
 * 用法：node run-regression.js
 *
 * 回归测试完全用本地生成的图片，不需要任何外部 API Key。
 */
const { spawn } = require('child_process');
const net = require('net');

const ROOT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个空闲端口，避免和本机已运行的服务撞车 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

(async () => {
  const port = await freePort();
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });

  let exitCode = 1;
  try {
    let up = false;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) { up = true; break; }
      } catch { /* 还没起来 */ }
      await sleep(150);
    }
    if (!up) throw new Error('server.js 未能启动');

    // regression.js 默认连接 http://127.0.0.1:8791，这里用 BASE 覆盖
    const child = spawn(process.execPath, ['regression.js'], {
      cwd: ROOT,
      env: { ...process.env, BASE: `http://127.0.0.1:${port}` },
      stdio: 'inherit',
    });
    exitCode = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
  } catch (e) {
    console.error('FATAL', e.message);
  } finally {
    try { srv.kill(); } catch {}
    await sleep(300);
  }
  process.exit(exitCode);
})();