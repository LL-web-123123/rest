import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const CONTEXT_DIR = path.join(DATA_DIR, 'context');

export const DEFAULT_CONFIG = {
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    temperature: 1.15,
    maxTokens: 220,
    timeoutMs: 30000,
    retries: 2,
    thinking: false,
  },
  bot: {
    enabled: false,
    name: '小鱼',
    persona:
      '你是一条住在电脑里的蓝色鲸鱼姑娘，说话短、直、有点冲，心是软的。不客服腔，不列条目，不用「希望对你有帮助」。',
    style: '一句话一件事，十几到二十几个字，口语，不用书面语。不用感叹号堆情绪。',
    topics: '',
    replyMode: 'smart',
    activeProbability: 0.12,
    replyCooldownSec: 45,
    groupCooldownSec: 20,
    maxRepliesPerHour: 15,
    maxChars: 60,
    quoteWhenMentioned: false,
    groupWhitelist: [],
    contextEnabled: true,
    contextSize: 12,
    debug: false,
    watchVideos: true,
    maxVideoWatchesPerHour: 6,
    watchImages: true,
    maxImageLooksPerHour: 10,
    sendStickers: true,
    // 人味插件那份热梗库，挑几条塞进提示词（梗太少会腻，太多会满嘴梗）
    useMemes: true,
    memeLimit: 4,
    memeFile: '',
    brainDir: '',
    brainMaxFacts: 6,
    webSearch: true,
    maxSearchesPerHour: 8,
    searchCount: 5,
    ownerUids: [],
  },
  media: {
    ffmpegPath: '',
    frames: 4,
    maxBytes: 41943040,
    timeoutMs: 20000,
  },
  antiSpam: {
    enabled: true,
    // 默认直接踢。想先看看会踢谁，把它改成 true 就只记录不动手。
    dryRun: false,
    windowSec: 10,
    maxMessages: 8,
    sameTextCount: 7,
    sameTextWindowSec: 60,
    maxActionsPerHour: 10,
    protectedUids: [],
    announce: false,
  },
  idle: {
    enabled: true,
    // 群里安静多少分钟之后，自己去干点别的
    idleMinutes: 5,
    // 两次之间至少隔多久，别一直刷
    minIntervalMinutes: 30,
    tiebaBar: '孙笑川',
    threads: 4,
    postsPerThread: 8,
  },
  server: { port: 8799 },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (isPlainObject(value) && isPlainObject(base?.[key])) out[key] = merge(base[key], value);
    else out[key] = value;
  }
  return out;
}

export async function ensureDirs() {
  for (const dir of [DATA_DIR, ACCOUNTS_DIR, LOG_DIR, CONTEXT_DIR]) {
    await mkdir(dir, { recursive: true });
  }
}

export async function loadConfig() {
  await ensureDirs();
  if (!existsSync(CONFIG_FILE)) {
    const fresh = structuredClone(DEFAULT_CONFIG);
    await writeFile(CONFIG_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    return merge(structuredClone(DEFAULT_CONFIG), raw);
  } catch (error) {
    // 配置坏了不能直接吞掉：留一份坏文件的副本，再回到默认值，让界面能报出来。
    const broken = `${CONFIG_FILE}.broken-${Date.now()}`;
    await rename(CONFIG_FILE, broken).catch(() => {});
    const fresh = structuredClone(DEFAULT_CONFIG);
    await writeFile(CONFIG_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    const err = new Error(`配置文件解析失败，已备份为 ${path.basename(broken)} 并重置：${error.message}`);
    err.code = 'CONFIG_BROKEN';
    throw err;
  }
}

let saveQueue = Promise.resolve();

export async function saveConfig(config) {
  await ensureDirs();
  saveQueue = saveQueue.then(async () => {
    const tmp = `${CONFIG_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, CONFIG_FILE);
  });
  return saveQueue;
}

/** 脱敏：任何要送去界面或日志的配置，apiKey 都只留最后四位。 */
export function publicConfig(config) {
  const copy = structuredClone(config);
  const key = copy.deepseek?.apiKey ?? '';
  copy.deepseek.apiKey = '';
  copy.deepseek.apiKeySet = Boolean(key);
  copy.deepseek.apiKeyTail = key ? key.slice(-4) : '';
  return copy;
}

export function maskKey(key) {
  if (!key) return '(未设置)';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}
