/**
 * 独立测试 DeepSeek 客户端：网络可达性、鉴权、错误码提示、真实回复。
 *
 *   node scripts/test-deepseek.mjs            用 data/config.json 里的 Key
 *   node scripts/test-deepseek.mjs --probe     只测「故意用错误 Key」，验证错误提示
 *
 * 不会打印 Key 本身。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekClient } from '../src/llm/deepseek.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probeOnly = process.argv.includes('--probe');

async function readKey() {
  try {
    const raw = JSON.parse(await readFile(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    return raw?.deepseek?.apiKey ?? '';
  } catch {
    return '';
  }
}

const baseSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: 1,
  maxTokens: 60,
  timeoutMs: 20000,
  retries: 0,
  thinking: false,
};

console.log('DeepSeek 客户端测试\n');

// 1) 故意用错误 Key：确认能连上官方接口，并把 401 翻译成人话
{
  const client = new DeepSeekClient(() => ({ ...baseSettings, apiKey: 'sk-invalid-probe-0000000000000000' }));
  const started = Date.now();
  try {
    await client.complete([{ role: 'user', content: '你好' }]);
    console.log('  [FAIL] 错误 Key 居然成功了，不正常');
    process.exitCode = 1;
  } catch (error) {
    const ms = Date.now() - started;
    if (error.status === 401) {
      console.log(`  [OK]   网络通，鉴权被拒（HTTP 401，${ms}ms）`);
      console.log(`         界面会显示：${error.message}`);
    } else {
      console.log(`  [WARN] 预期 401，实际：${error.message}（status=${error.status}，${ms}ms）`);
    }
  }
}

if (!probeOnly) {
  const apiKey = await readKey();
  if (!apiKey) {
    console.log('\n  [SKIP] data/config.json 里还没填 API Key，真实回复测试跳过。');
    console.log('         在界面「设置 → API Key」里填好后，再跑一次这个脚本。');
  } else {
    const client = new DeepSeekClient(() => ({ ...baseSettings, apiKey }));
    const started = Date.now();
    try {
      const reply = await client.ping();
      console.log(`\n  [OK]   真实调用成功（${Date.now() - started}ms），模型回：${reply}`);
      console.log(`         token 用量：输入 ${client.stats.promptTokens}，输出 ${client.stats.completionTokens}`);
    } catch (error) {
      console.log(`\n  [FAIL] 真实调用失败：${error.message}${error.detail ? ` —— ${error.detail}` : ''}`);
      process.exitCode = 1;
    }
  }
}
