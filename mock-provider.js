/** 本地 mock 供应商，验证 /api/chat 的 SSE 解析（含 reasoning_content） */
const http = require('http');
http.createServer((req, res) => {
  if (req.url.includes('chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { choices: [{ delta: { reasoning_content: '让我想想…' } }] },
      { choices: [{ delta: { content: '推荐' } }] },
      { choices: [{ delta: { content: '莫兰迪' } }] },
      { choices: [{ delta: { content: '色系。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 12 } },
    ];
    chunks.forEach((c, i) => setTimeout(() => res.write(`data: ${JSON.stringify(c)}\n\n`), i * 30));
    setTimeout(() => { res.write('data: [DONE]\n\n'); res.end(); }, chunks.length * 30 + 30);
  } else {
    res.writeHead(404); res.end();
  }
}).listen(8799, () => console.log('mock on 8799'));
