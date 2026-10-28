import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.mjs';

const logger = createLogger('贴吧');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 贴吧 cookie 跟着包走，不再写死某台机器的绝对路径
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COOKIE_FILE = path.join(ROOT, 'data', 'tieba-cookies.json');

function cookieHeader() {
  try {
    const list = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (!Array.isArray(list) || !list.length) return '';
    return list.filter((c) => c && c.name).map((c) => c.name + '=' + c.value).join('; ');
  } catch {
    return '';
  }
}

async function get(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (/百度安全验证|请输入验证码|访问过于频繁/.test(text)) throw new Error('被百度要求验证了');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从「吧」的列表页里抠出帖子标题和 tid。 */
export function parseThreadList(html) {
  const out = [];
  const seen = new Set();
  const re = /data-tid="(\d+)"[\s\S]{0,3000}?<a[^>]*href="\/p\/\1[^"]*"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,600}?)(?=<li|$)/g;
  for (const match of String(html ?? '').matchAll(re)) {
    const tid = match[1];
    const title = stripHtml(match[2]);
    if (!title || seen.has(tid)) continue;
    seen.add(tid);
    const tail = match[3] ?? '';
    const rep = tail.match(/btn_reply[^>]*>\s*<span[^>]*>\s*(\d+)/);
    out.push({ tid, title, replies: rep ? Number(rep[1]) : 0 });
  }
  return out;
}

/** 从帖子页里抠楼层正文。 */
export function parsePosts(html, { max = 20 } = {}) {
  const out = [];
  const re = /<div class="content"[^>]*>([\s\S]*?)<\/div>/g;
  for (const match of String(html ?? '').matchAll(re)) {
    const text = stripHtml(match[1]);
    if (text.length < 4) continue;
    if (/^(广告|下载贴吧|打开贴吧)/.test(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** 拿去当语料之前先筛一遍：太短的、带联系方式的、带链接的都不要。 */
export function keepLearnable(text) {
  const value = String(text ?? '').trim();
  if (value.length < 6 || value.length > 300) return false;
  if (/https?:\/\/|www\.|\.com|微信|加我|QQ群|vx/i.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  return true;
}

/** 允许多个吧，逗号隔开，每次随机挑一个。 */
export function pickBar(value, fallback = '孙笑川') {
  const bars = String(value ?? '')
    .split(/[,，\s]+/)
    .map((item) => item.trim().replace(/吧$/, ''))
    .filter(Boolean);
  if (!bars.length) return fallback;
  return bars[Math.floor(Math.random() * bars.length)];
}

export async function fetchThreads(kw, { pn = 0 } = {}) {
  const url = `https://tieba.baidu.com/mo/q/m?kw=${encodeURIComponent(kw)}&pn=${pn}`;
  const html = await get(url);
  const list = parseThreadList(html);
  logger.info(`刷「${kw}吧」：拿到 ${list.length} 个帖子`);
  return list;
}

export async function fetchThread(tid, { max = 12 } = {}) {
  const url = `https://tieba.baidu.com/mo/q/m?kz=${encodeURIComponent(tid)}`;
  const html = await get(url);
  return parsePosts(html, { max });
}

/**
 * 一次「刷贴吧」：拿标题 + 几个帖子的正文，挑出能学的句子。
 * 只读，不登录、不发帖、不回帖。
 */
export async function browse({ kw, threads = 4, postsPerThread = 8, sortByHot = false } = {}) {
  const list = await fetchThreads(kw);
  let pool = list.filter((item) => !/^置顶/.test(item.title));
  if (sortByHot) pool = pool.slice().sort((a, b) => (b.replies ?? 0) - (a.replies ?? 0));
  const picked = pool.slice(0, Math.max(1, threads));
  const corpus = [];
  for (const thread of picked) {
    try {
      const posts = await fetchThread(thread.tid, { max: postsPerThread + 4 });
      const kept = posts.filter(keepLearnable).slice(0, postsPerThread);
      for (const text of kept) corpus.push(text);
      logger.info(`  《${thread.title.slice(0, 30)}》读到 ${kept.length} 条`);
    } catch (error) {
      logger.warn(`  帖子 ${thread.tid} 读失败：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { kw, threads: picked.length, corpus };
}
