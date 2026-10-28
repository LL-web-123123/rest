/**
 * 假的 OpenAI 兼容接口，用来在没有真实 Key 的情况下验证整条链路。
 * 只在测试时启动：node scripts/mock-deepseek.mjs
 *
 * 规则（方便控制返回值）：
 *   最后一条消息里含「别回」 → 返回 [PASS]
 *   含「报错」               → 返回 500
 *   其他                     → 返回一句固定的话，带上触发词
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8899);

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const messages = body.messages ?? [];
  const last = String(messages.at(-1)?.content ?? '');

  if (!req.headers.authorization?.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'missing key' } }));
    return;
  }

  if (last.includes('报错')) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock 500' } }));
    return;
  }

  const content = last.includes('别回')
    ? '[PASS]'
    : `收到：「${last.slice(0, 20).replace(/^.*?：/, '')}」，我在。`;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock',
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock deepseek listening on http://127.0.0.1:${port}`);
});
