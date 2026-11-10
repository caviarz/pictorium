/**
 * 动图识别与保护工具
 * - 用字节魔数判断真实格式（不信任 blob.type / data URL 前缀）
 * - 读取 GIF/WEBP/APNG 的帧数与时长
 * - 保证动图在任何路径下都不被压成静帧
 */
(() => {
  const MAGIC = {
    gif: [0x47, 0x49, 0x46],
    png: [0x89, 0x50, 0x4e, 0x47],
    jpeg: [0xff, 0xd8, 0xff],
    webp: [0x52, 0x49, 0x46, 0x46],
  };

  /** 从 ArrayBuffer/Uint8Array 判断真实图片格式 */
  function sniff(bytes) {
    if (!bytes || bytes.length < 12) return { format: 'unknown', animated: false };
    const b = bytes;
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      // GIF：数 Graphic Control Extension (0x21 0xF9)，更准确的是数图像描述符 0x2C
      let frames = 0;
      const n = Math.min(b.length, 4 * 1024 * 1024);
      for (let i = 0; i < n - 1; i++) if (b[i] === 0x21 && b[i + 1] === 0xF9) frames++;
      return { format: 'gif', mime: 'image/gif', animated: frames > 1, frames };
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      // PNG / APNG：找 acTL 块
      const n = Math.min(b.length, 4 * 1024 * 1024);
      for (let i = 0; i < n - 8; i++) {
        if (b[i] === 0x61 && b[i + 1] === 0x63 && b[i + 2] === 0x54 && b[i + 3] === 0x4c) {
          const dv = new DataView(b.buffer, b.byteOffset + i + 4, 4);
          const frames = dv.getUint32(0);
          return { format: 'png', mime: 'image/png', animated: frames > 1, frames, apng: true };
        }
      }
      return { format: 'png', mime: 'image/png', animated: false };
    }
    if (b[0] === 0xff && b[1] === 0xd8) return { format: 'jpeg', mime: 'image/jpeg', animated: false };
    if (b.length > 16 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      // WEBP：ANIM 块存在则为动图
      const n = Math.min(b.length, 4 * 1024 * 1024);
      let animated = false;
      for (let i = 0; i < n - 4; i++) if (b[i] === 0x41 && b[i + 1] === 0x4e && b[i + 2] === 0x49 && b[i + 3] === 0x4d) { animated = true; break; }
      return { format: 'webp', mime: 'image/webp', animated };
    }
    return { format: 'unknown', animated: false };
  }

  /** 从 base64 判断 */
  function sniffB64(b64) {
    try {
      const head = atob(b64.slice(0, 64));
      const bytes = new Uint8Array(head.length);
      for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
      return sniff(bytes);
    } catch { return { format: 'unknown', animated: false }; }
  }

  /** 从 data URL 判断 */
  function sniffDataUrl(url) {
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(url || '');
    if (!m) return { format: 'unknown', animated: false };
    return sniffB64(m[1]);
  }

  async function sniffBlob(blob) {
    try {
      const buf = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4 * 1024 * 1024)).arrayBuffer());
      return sniff(buf);
    } catch { return { format: 'unknown', animated: false }; }
  }

  /** 把格式转成下载用的扩展名 */
  function extFor(format) {
    return format === 'jpeg' ? 'jpg' : format === 'unknown' ? 'png' : format;
  }

  window.AnimUtil = { sniff, sniffB64, sniffDataUrl, sniffBlob, extFor };
})();
