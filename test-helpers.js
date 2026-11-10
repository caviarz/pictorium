/**
 * 测试脚本共用的浏览器定位逻辑（跨平台）。
 *
 * 查找顺序：
 *   1. CHROME_PATH 环境变量
 *   2. playwright 浏览器缓存目录（Windows / Linux / macOS）
 *   3. 系统安装的 Chrome / Chromium / Edge
 *
 * 找不到时抛错并提示设置 CHROME_PATH，而不是抛出一个看不懂的 ENOENT。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** playwright 缓存目录在各平台的位置 */
function cacheRoots() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  }
  if (process.env.HOME) roots.push(path.join(process.env.HOME, '.cache', 'ms-playwright'));
  if (process.env.XDG_CACHE_HOME) roots.push(path.join(process.env.XDG_CACHE_HOME, 'ms-playwright'));
  roots.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')); // macOS
  roots.push(path.join(os.tmpdir(), 'ms-playwright'));
  return roots;
}

/** 各平台下 chromium 可执行文件的相对路径 */
const CHROMIUM_RELS = [
  'chrome-win\\chrome.exe',
  'chrome-win64\\chrome.exe',
  'chrome-linux/chrome',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
];

/** 系统已装的浏览器 */
function systemBrowsers() {
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  return candidates;
}

function findChromium() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`CHROME_PATH 指向的文件不存在: ${explicit}`);
  }

  for (const root of cacheRoots()) {
    let dirs;
    try {
      if (!fs.existsSync(root)) continue;
      dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    } catch { continue; }
    for (const d of dirs) {
      for (const rel of CHROMIUM_RELS) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }

  for (const p of systemBrowsers()) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    '未找到 Chromium / Chrome / Edge。\n'
    + '请安装其一，或运行 `npx playwright install chromium`，\n'
    + '或设置环境变量 CHROME_PATH 指向浏览器可执行文件。',
  );
}

module.exports = { findChromium };
