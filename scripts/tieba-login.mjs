// 开一个窗口让你登录贴吧，登录成功就把 cookie 存下来给爬虫用
// 用法：先 npm i -D playwright && npx playwright install msedge，再 node scripts/tieba-login.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROFILE = path.join(ROOT, 'data', 'tieba-profile');
const OUT = path.join(ROOT, 'data', 'tieba-cookies.json');

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: false,
  args: ['--window-position=80,60', '--window-size=1180,860'],
  viewport: null,
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://tieba.baidu.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
console.log('[open] 贴吧已打开，请在窗口里登录');

let saved = false;
for (let i = 0; i < 240; i += 1) {
  await new Promise((r) => setTimeout(r, 2500));
  const cookies = await ctx.cookies();
  const names = new Set(cookies.map((c) => c.name));
  if (names.has('BDUSS')) {
    fs.writeFileSync(OUT, JSON.stringify(cookies, null, 2), 'utf8');
    console.log('[ok] 已登录，cookie 存到', OUT);
    saved = true;
    break;
  }
  if (i % 8 === 0) console.log('[wait] 还没登录…');
}

if (!saved) console.log('[fail] 十分钟没等到登录');
await new Promise((r) => setTimeout(r, 1500));
await ctx.close().catch(() => {});
