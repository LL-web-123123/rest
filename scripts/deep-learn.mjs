// 手动深刷一次贴吧：10 个帖子 × 每个 50 楼
import { loadConfig } from '../src/config.mjs';
import { DeepSeekClient } from '../src/llm/deepseek.mjs';
import { browse } from '../src/idle/tieba.mjs';
import { learnStyle } from '../src/idle/learner.mjs';

const config = await loadConfig();
// DeepSeekClient 要的是一份「怎么取设置」的函数
const deepseek = new DeepSeekClient(() => config.deepseek);
const kw = process.argv[2] || '孙笑川';
const threads = Number(process.argv[3] || 10);
const floors = Number(process.argv[4] || 50);

console.log(`开始：${kw}吧，${threads} 个帖子，每个 ${floors} 楼`);
const { corpus, threads: got } = await browse({ kw, threads, postsPerThread: floors, sortByHot: true });
console.log(`读到 ${got} 个帖子，语料 ${corpus.length} 条`);
if (!corpus.length) process.exit(1);

const out = await learnStyle({
  deepseek,
  corpus,
  brainDir: config.bot?.brainDir,
  kw,
});
console.log('结果:', JSON.stringify(out));
